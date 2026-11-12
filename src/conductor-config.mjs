import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { backendName } from './backends.mjs';
import { validateModelPin } from './prompt.mjs';
import { DEFAULT_CONTEXT, validateContextConfig } from './context-config.mjs';

export const DEFAULT_SPECIALISTS = Object.freeze({
  enabled: false,
  explore: true,
  check: true,
  models: {},
  maxCalls: 12,
  maxExplorerCalls: 6,
  maxCheckerCalls: 6,
  maxDiffChars: 16000,
  maxTestSeconds: 30,
  context: DEFAULT_CONTEXT,
});
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
  specialists: DEFAULT_SPECIALISTS,
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
  backendName(cfg.provider);
  if (!['claude', 'codex'].includes(cfg.provider)) {
    throw new Error('Conductor AI is currently supported only for Claude and Codex');
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
  const inputSpecialists = cfg.specialists;
  if (!inputSpecialists || typeof inputSpecialists !== 'object' || Array.isArray(inputSpecialists)) {
    throw new Error('conductor.specialists must be an object');
  }
  for (const key of Object.keys(inputSpecialists)) {
    if (!Object.hasOwn(DEFAULT_SPECIALISTS, key)) throw new Error('Unknown conductor.specialists setting: ' + key);
  }
  const specialists = { ...DEFAULT_SPECIALISTS, ...inputSpecialists };
  for (const key of ['enabled', 'explore', 'check']) {
    if (typeof specialists[key] !== 'boolean') throw new Error('conductor.specialists.' + key + ' must be boolean');
  }
  for (const [key, min, max] of [
    ['maxCalls', 1, 100], ['maxExplorerCalls', 1, 100], ['maxCheckerCalls', 1, 100],
    ['maxDiffChars', 2000, 64000], ['maxTestSeconds', 1, 120],
  ]) {
    if (!Number.isInteger(specialists[key]) || specialists[key] < min || specialists[key] > max) {
      throw new Error('conductor.specialists.' + key + ' must be an integer between ' + min + ' and ' + max);
    }
  }
  if (!specialists.models || typeof specialists.models !== 'object' || Array.isArray(specialists.models)) {
    throw new Error('conductor.specialists.models must be an object');
  }
  for (const [role, model] of Object.entries(specialists.models)) {
    if (!['explorer', 'fixer', 'checker'].includes(role)) throw new Error('Unsupported specialist model role: ' + role);
    validateModelPin(cfg.provider, model);
  }
  return { ...cfg, models: { ...cfg.models }, specialists: { ...specialists,
    models: { ...specialists.models }, context: validateContextConfig(specialists.context) } };
}
export function readConductorConfig(repo) {
  const path = join(repo, 'iwsdk-agent-kit.config.json');
  const project = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  return validateConductorConfig(project.conductor ?? {});
}
