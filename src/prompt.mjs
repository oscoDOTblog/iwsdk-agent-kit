import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { backendName } from './backends.mjs';

export const DEFAULT_PROMPT_BUDGET = Object.freeze({ projectChars: 12000, handoffChars: 3500 });
const safeModel = /^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,127}$/;
export function validateModelPin(backend, model) {
  backendName(backend);
  if (typeof model !== 'string' || !safeModel.test(model)) throw new Error('Invalid worker model identifier for ' + backend);
  if (backend === 'muse') throw new Error('Model pinning is not verified for Muse; omit workerModels.muse');
  return model;
}
export function readPromptSettings(root) {
  const path = join(root, 'iwsdk-agent-kit.config.json');
  const config = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const budget = { ...DEFAULT_PROMPT_BUDGET, ...(config.promptContextBudget ?? {}) };
  for (const key of Object.keys(budget)) {
    if (!Object.hasOwn(DEFAULT_PROMPT_BUDGET, key)) throw new Error('Unknown promptContextBudget setting: ' + key);
    if (!Number.isInteger(budget[key]) || budget[key] < 500 || budget[key] > 16000) {
      throw new Error('promptContextBudget.' + key + ' must be 500..16000 characters');
    }
  }
  const workerModels = config.workerModels ?? {};
  if (!workerModels || typeof workerModels !== 'object' || Array.isArray(workerModels)) {
    throw new Error('workerModels must be a map of provider to model identifier');
  }
  for (const [backend, model] of Object.entries(workerModels)) validateModelPin(backend, model);
  return { promptContextBudget: budget, workerModels: { ...workerModels } };
}
export function boundedText(value, maxChars, label = 'Context') {
  const text = String(value ?? '');
  if (text.length <= maxChars) return text;
  const marker = '\n[' + label + ' truncated; inspect the source file for details.]';
  return text.slice(0, Math.max(0, maxChars - marker.length)) + marker;
}
export function stablePromptPrefix(role, projectContext) {
  return [
    role.trimEnd(),
    '',
    'Implement only the approved assignment. Follow root and scoped AGENTS.md and inspect the actual project architecture.',
    'Shared project context (coordinator-owned; do not edit from this feature worker):',
    projectContext,
    '',
    'Safety and verification:',
    '- Own only assigned paths; report required changes elsewhere as BLOCKED.',
    '- Preserve partial work. Never reset, stash, discard, or overwrite unrelated work.',
    '- Do not change dependencies or save formats without explicit ownership and authorization.',
    '- No recursive agents, IWSDK/browser/XR sessions, push, PR, or merge to the base branch.',
    '- Run only checks actually available. Commit finished changes on the assigned branch.',
    '- Report exact checks, limitations, runtime acceptance steps, and commit hash.',
    '- If sandbox, network, or usage limits block work, report BLOCKED; never escalate.',
    '',
  ].join('\n');
}
export function buildWorkerPrompt({ role, projectContext, checkpoint, feature, baseline }) {
  // The role, static rules and project context form a reusable prefix. All
  // changing task/attempt details go last, in a stable field order.
  return stablePromptPrefix(role, projectContext) + [
    'Current assignment and recovery context (dynamic; read after the stable project rules):',
    'Assignment:',
    JSON.stringify({
      id: feature.id, description: feature.description, owns: feature.owns,
      acceptance: feature.acceptance, interfaces: feature.interfaces,
      dependsOn: feature.dependsOn, decisions: feature.decisions ?? [],
      contentChanges: feature.contentChanges, runtimeRequired: feature.runtimeRequired,
    }, null, 2),
    'Baseline commit: ' + baseline,
    'Previous checkpoint (unverified; inspect before resuming):',
    checkpoint || '(first attempt; no previous checkpoint)',
    '',
  ].join('\n');
}
