import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { backendName } from './backends.mjs';
import { validateModelPin } from './prompt.mjs';

export const DEFAULT_CONDUCTOR = Object.freeze({
  enabled: false,
  provider: 'claude',
  aiPlanning: true,
  aiVerification: true,
  maxParallelWorkers: 2,
  maxWorkerStarts: 12,
  maxRetriesPerFeature: 0,
  maxRunMinutes: 30,
  autoIntegrate: false,
  models: {},
});
const fields = new Set(Object.keys(DEFAULT_CONDUCTOR));
export function validateConductorConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('conductor must be an object');
  for (const key of Object.keys(input)) if (!fields.has(key)) throw new Error('Unknown conductor setting: ' + key);
  const cfg = { ...DEFAULT_CONDUCTOR, ...input };
  for (const key of ['enabled', 'aiPlanning', 'aiVerification']) {
    if (typeof cfg[key] !== 'boolean') throw new Error('conductor.' + key + ' must be boolean');
  }
  if (cfg.autoIntegrate !== false) throw new Error('Conductor cannot auto-integrate; autoIntegrate must be false');
  if (cfg.provider === 'auto') {
    // Model pins are provider-specific and must not leak into another CLI.
    if (cfg.models && typeof cfg.models === 'object' && !Array.isArray(cfg.models) &&
        Object.keys(cfg.models).length) {
      throw new Error('conductor.models cannot be pinned when provider is "auto"');
    }
  } else {
    backendName(cfg.provider);
    if (!['claude', 'codex'].includes(cfg.provider)) {
      throw new Error('Conductor AI is currently supported only for Claude and Codex');
    }
  }
  for (const [key, min, max] of [
    ['maxParallelWorkers', 1, 3], ['maxWorkerStarts', 1, 100],
    ['maxRetriesPerFeature', 0, 2], ['maxRunMinutes', 1, 240],
  ]) {
    if (!Number.isInteger(cfg[key]) || cfg[key] < min || cfg[key] > max) {
      throw new Error('conductor.' + key + ' must be an integer between ' + min + ' and ' + max);
    }
  }
  if (!cfg.models || typeof cfg.models !== 'object' || Array.isArray(cfg.models)) {
    throw new Error('conductor.models must be a map of role to model');
  }
  for (const [role, model] of Object.entries(cfg.models)) {
    if (!['planner', 'verifier'].includes(role)) throw new Error('Unsupported conductor model role: ' + role);
    validateModelPin(cfg.provider, model);
  }
  return { ...cfg, models: { ...cfg.models } };
}
/** Resolve AI planner/verifier provider only when those AI roles are enabled. */
export function resolveConductorProvider(cfg, coordinator) {
  if (cfg.provider !== 'auto' || (!cfg.aiPlanning && !cfg.aiVerification)) return cfg;
  if (!coordinator) {
    throw new Error('conductor.provider "auto" needs a detected coordinator; set IWSDK_AGENT_COORDINATOR');
  }
  if (!['claude', 'codex'].includes(coordinator.backend)) {
    throw new Error('Conductor AI is currently supported only for Claude and Codex; ' +
      'disable aiPlanning/aiVerification for ' + coordinator.backend);
  }
  return { ...cfg, provider: coordinator.backend };
}
export function readConductorConfig(repo) {
  const path = join(repo, 'iwsdk-agent-kit.config.json');
  const project = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  return validateConductorConfig(project.conductor ?? {});
}
