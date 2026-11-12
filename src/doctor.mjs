import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readProviderPolicy } from './provider-policy.mjs';
import { readPromptSettings } from './prompt.mjs';
const read = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
export function inspectProject(root = process.cwd()) {
  const pkg = read(join(root, 'package.json')) ?? {};
  const manifest = read(join(root, 'iwsdk.config.json'));
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' });
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const sdk = Object.fromEntries(Object.entries(deps).filter(([key]) => /iwsdk|immersive-web/i.test(key)));
  return {
    root, git: git.status === 0 ? git.stdout.trim() : null,
    node: process.version, language: existsSync(join(root, 'tsconfig.json')) ? 'TypeScript' : 'unknown',
    sdk, scripts: pkg.scripts ?? {}, manifest: manifest ?? 'not found',
    providerPolicy: readProviderPolicy(root),
    promptSettings: readPromptSettings(root),
    capabilities: manifest?.world?.features ?? 'unknown',
    notes: ['IWSDK capabilities are detected, not modified', 'Unknown settings require manual verification', 'Provider isolation is strict; active coordinator detection is best-effort and project backend is the fallback'],
  };
}
