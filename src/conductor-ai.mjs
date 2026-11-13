import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { workerEnvironment } from './backends.mjs';
import { extractUsage } from './usage.mjs';

const MAX_OUTPUT = 8 * 1024 * 1024;
const MAX_PROMPT = 24000;
const limited = value => String(value ?? '').slice(0, MAX_PROMPT);
export function plannerPrompt(state) {
  const features = state.features.map(f => ({
    id: f.id, description: f.description, dependsOn: f.dependsOn,
    owns: f.owns, acceptance: f.acceptance, interfaces: f.interfaces,
  }));
  return [
    'You are a read-only coordinator, NOT a coding worker.',
    'No tools, file edits, subagents, shell commands, model switching, or provider handoffs.',
    'All tasks, ownership boundaries, and dependencies are already approved and fixed.',
    'Propose a priority order only; the deterministic runner will enforce all dependencies and limits.',
    'Do not add tasks, alter acceptance criteria, or claim tests were run.',
    'Return ONLY JSON: {"priority":["every feature id exactly once"],"risks":[{"feature":"id","risk":"short concern"}],"notes":"short rationale"}.',
    'Batch:', limited(JSON.stringify({ id: state.id, features }, null, 2)),
  ].join('\n\n');
}
export function verifierPrompt(state, ledger) {
  const features = state.features.map(f => ({
    id: f.id, status: f.status, head: f.head ?? null, acceptance: f.acceptance,
  }));
  return [
    'You are a read-only independent review advisor, not an approval authority.',
    'No tools, file edits, subagents, shell commands, model switching, or provider handoffs.',
    'Worker summaries and ledger entries are claims, not proof. You have not inspected the actual code.',
    'Do NOT mark any criterion passed, invent test output, or authorize integration or publishing.',
    'Identify risks and the checks a human reviewer must perform on the current commits.',
    'Return ONLY JSON: {"findings":[{"feature":"id","severity":"high|medium|low","summary":"short concern"}],"summary":"short review advice"}.',
    'Features:', limited(JSON.stringify(features, null, 2)),
    'Acceptance ledger:', limited(JSON.stringify(ledger, null, 2)),
  ].join('\n\n');
}
export function validatePlanner(value, state) {
  if (!value || !Array.isArray(value.priority) || value.priority.length !== state.features.length ||
      new Set(value.priority).size !== state.features.length ||
      value.priority.some(id => !state.features.some(f => f.id === id))) {
    throw new Error('Planner must return every existing feature ID exactly once');
  }
  if (!Array.isArray(value.risks) || value.risks.length > 50 ||
      value.risks.some(r => !state.features.some(f => f.id === r.feature) ||
        typeof r.risk !== 'string' || r.risk.length > 1000)) {
    throw new Error('Invalid planner risks');
  }
  if (typeof value.notes !== 'string' || value.notes.length > 3000) throw new Error('Invalid planner notes');
  return { priority: value.priority, risks: value.risks, notes: value.notes };
}
export function validateVerifier(value, state) {
  if (!value || !Array.isArray(value.findings) || value.findings.length > 100 ||
      value.findings.some(f => !state.features.some(x => x.id === f.feature) ||
        !['high', 'medium', 'low'].includes(f.severity) ||
        typeof f.summary !== 'string' || f.summary.length > 1500) ||
      typeof value.summary !== 'string' || value.summary.length > 3000) {
    throw new Error('Invalid verifier response');
  }
  return { findings: value.findings, summary: value.summary };
}
function parseJsonText(text) {
  try { return JSON.parse(text.trim()); }
  catch { throw new Error('Coordinator returned invalid JSON; no action was taken based on its response'); }
}
export function coordinatorInvocation(provider, model, prompt, outputPath) {
  if (provider === 'claude') return {
    command: 'claude',
    args: ['-p', ...(model ? ['--model', model] : []), '--output-format', 'json',
      '--permission-mode', 'dontAsk', '--tools', ''],
    stdin: prompt,
  };
  if (provider === 'codex') return {
    command: 'codex',
    args: ['exec', ...(model ? ['-m', model] : []), '--sandbox', 'read-only',
      '-c', 'approval_policy="never"', '-c', 'agents.enabled=false', '--json',
      '--output-last-message', outputPath, '-'],
    stdin: prompt,
  };
  throw new Error('Unsupported conductor provider: ' + provider);
}
export function runCoordinatorRole(state, cfg, role, prompt, { execute = spawnSync } = {}) {
  if (!['planner', 'verifier'].includes(role)) throw new Error('Unsupported coordinator role');
  const directory = join(state.directory, 'conductor');
  mkdirSync(directory, { recursive: true });
  const outputPath = join(directory, role + '-last-message.txt');
  const invocation = coordinatorInvocation(cfg.provider, cfg.models[role] ?? null, prompt, outputPath);
  const result = execute(invocation.command, invocation.args, {
    cwd: state.repo, input: invocation.stdin, encoding: 'utf8', maxBuffer: MAX_OUTPUT,
    timeout: 120000, env: workerEnvironment(cfg.provider),
  });
  // Local logs remain inside the batch; no automatic provider or external upload.
  if (typeof result.stdout === 'string') writeFileSync(join(directory, role + '.jsonl'), result.stdout);
  if (result.error || result.status !== 0) {
    throw new Error('Conductor ' + role + ' failed (' + (result.error?.message ?? result.status) +
      '); inspect local logs. No unapproved fallback or model switch was attempted');
  }
  let answer;
  if (cfg.provider === 'claude') {
    const envelope = parseJsonText(result.stdout);
    if (envelope.is_error || (envelope.subtype && envelope.subtype !== 'success') ||
        (Array.isArray(envelope.permission_denials) && envelope.permission_denials.length) ||
        typeof envelope.result !== 'string') {
      throw new Error('Claude conductor result was unsuccessful or denied permissions');
    }
    answer = envelope.result;
  } else {
    if (!existsSync(outputPath)) throw new Error('Codex conductor did not write its last message');
    answer = readFileSync(outputPath, 'utf8');
  }
  const data = parseJsonText(answer);
  return {
    data: role === 'planner' ? validatePlanner(data, state) : validateVerifier(data, state),
    provider: cfg.provider, model: cfg.models[role] ?? null,
    usage: extractUsage(cfg.provider, result.stdout ?? ''),
    at: new Date().toISOString(),
  };
}
