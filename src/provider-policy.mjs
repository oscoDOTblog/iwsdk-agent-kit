import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { backendName } from './backends.mjs';

/**
 * Provider isolation is a coordinator policy, not a sandbox or billing boundary.
 * Never infer permission to spend on another CLI from a feature's batch JSON.
 */
export function detectCoordinator(source = process.env) {
  const explicit = source.IWSDK_AGENT_COORDINATOR;
  if (explicit) return { backend: backendName(explicit), source: 'IWSDK_AGENT_COORDINATOR' };
  const detected = [];
  if (source.CODEX_THREAD_ID) detected.push({ backend: 'codex', source: 'CODEX_THREAD_ID' });
  if (source.CLAUDECODE && source.CLAUDECODE !== '0' && source.CLAUDECODE !== 'false') {
    detected.push({ backend: 'claude', source: 'CLAUDECODE' });
  }
  if (detected.length > 1) {
    throw new Error('Conflicting coordinator session markers; set IWSDK_AGENT_COORDINATOR explicitly or run in a clean terminal');
  }
  return detected[0] ?? null;
}

export function readProviderPolicy(repo, source = process.env) {
  const path = join(repo, 'iwsdk-agent-kit.config.json');
  const config = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  if (config.providerIsolation !== undefined && config.providerIsolation !== 'strict') {
    throw new Error('providerIsolation must be "strict"; provider switching requires an explicit per-command override');
  }
  const coordinator = detectCoordinator(source);
  return {
    mode: 'strict',
    configuredBackend: resolveConfiguredBackend(config.backend, coordinator),
    auto: config.backend === 'auto',
    coordinator,
    configPath: path,
  };
}

/**
 * Explicit opt-in: use the provider of the current coordinating CLI.
 * A missing/ambiguous coordinator must fail closed rather than spend on a guess.
 * OpenCode and Muse need IWSDK_AGENT_COORDINATOR=opencode|muse.
 * Once a batch is planned, its backend remains fixed in batch state.
 */
export function resolveConfiguredBackend(value, coordinator) {
  if (value !== 'auto') return backendName(value ?? 'codex');
  if (!coordinator) {
    throw new Error('backend "auto" follows the coordinating CLI, but none was detected. ' +
      'Set IWSDK_AGENT_COORDINATOR=codex|claude|opencode|muse or select a named backend. No worker was launched.');
  }
  return backendName(coordinator.backend);
}

function approvedTargets(flags) {
  const approved = new Set();
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] !== '--allow-cross-provider') continue;
    if (!flags[i + 1] || flags[i + 1].startsWith('--')) {
      throw new Error('--allow-cross-provider requires a named backend: codex|claude|opencode|muse');
    }
    approved.add(backendName(flags[++i]));
  }
  return approved;
}

/** Enforce at plan AND start, including batches created before this policy existed. */
export function enforceProviderIsolation(policy, workerBackends, flags = [], action = 'run') {
  const requested = [...new Set(workerBackends.map(value => backendName(value)))];
  const mismatches = requested.filter(value =>
    value !== policy.configuredBackend || (policy.coordinator && value !== policy.coordinator.backend));
  const approved = approvedTargets(flags);
  if (mismatches.length && (!flags.includes('--approve') || mismatches.some(value => !approved.has(value)))) {
    const detected = policy.coordinator
      ? `; detected coordinator ${policy.coordinator.backend} (${policy.coordinator.source})`
      : '; coordinator not detected (project config is authoritative)';
    throw new Error(
      `Provider isolation blocked ${action}: worker backend(s) ${mismatches.join(', ')} do not match configured ${policy.configuredBackend}${detected}. ` +
      `To authorize a specific other provider for THIS command, add --allow-cross-provider <backend> --approve. ` +
      `Otherwise set iwsdk-agent-kit.config.json backend to your intended CLI. No worker was launched.`
    );
  }
  return {
    configuredBackend: policy.configuredBackend,
    detectedCoordinator: policy.coordinator?.backend ?? null,
    requested,
    explicitCrossProviderApprovals: mismatches,
  };
}
