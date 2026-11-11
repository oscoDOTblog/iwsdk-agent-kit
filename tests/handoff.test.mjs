import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { install } from '../src/install.mjs';
import { backendName, backendRole, workerInvocation, parseWorkerResult } from '../src/backends.mjs';
import { renderHandoff, sharedContext, handoffPath, classifyFailure } from '../src/handoff.mjs';
import { main } from '../src/orchestrator.mjs';

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function feature() {
  return { id: 'first', description: 'Build one independent feature', owns: ['src/feature/'],
    acceptance: ['Feature passes its tests'], interfaces: 'none', contentChanges: false,
    runtimeRequired: false, dependsOn: [] };
}
test('Muse Code is an explicit sandboxed headless backend', () => {
  assert.equal(backendName('muse'), 'muse');
  assert.equal(backendRole('muse'), '.agents/agents/feature-engineer.md');
  const cmd = workerInvocation('muse', { worktree: '/tmp/feature', attemptDirectory: '/tmp/log' }, '/tmp/git', 'Task');
  assert.equal(cmd.command, 'muse');
  assert.equal(cmd.args[0], 'exec');
  assert.ok(cmd.args.includes('--disable-approval'));
  assert.ok(cmd.args.includes('--max-model-steps'));
  assert.ok(!cmd.args.includes('--yolo'));
  assert.equal(cmd.args.at(-1), 'Task');
  assert.equal(parseWorkerResult('muse', 'Implemented feature; tests passed.'), 'Implemented feature; tests passed.');
  assert.throws(() => parseWorkerResult('muse', ' '), /empty report/);
});
test('installer adds shared context and Muse while backing up changed managed files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iwsdk-muse-install-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  writeFileSync(join(dir, 'AGENTS.md'), 'My own rules\n');
  const before = install(dir, { dryRun: true });
  assert.ok(before.some(x => x.path.endsWith('AGENT_CONTEXT.md')));
  assert.ok(!existsSync(join(dir, 'AGENT_CONTEXT.md')));
  install(dir);
  assert.ok(existsSync(join(dir, '.agents/agents/feature-engineer.md')));
  assert.ok(existsSync(join(dir, 'scripts/handoff.mjs')));
  assert.match(readFileSync(join(dir, 'AGENT_CONTEXT.md'), 'utf8'), /Shared Agent Context/);
  assert.match(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), /My own rules/);
  assert.match(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), /AGENT_CONTEXT.md/);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['agents:handoff'], 'node scripts/agents.mjs handoff');
  writeFileSync(join(dir, 'scripts/agents.mjs'), '// user modification\n');
  writeFileSync(join(dir, 'AGENT_CONTEXT.md'), '# My own context\n');
  const result = install(dir);
  assert.ok(result.some(x => x.action === 'backup' && x.path.endsWith('scripts/agents.mjs')));
  assert.ok(result.some(x => x.action === 'conflict' && x.path.endsWith('AGENT_CONTEXT.md')));
  assert.equal(readFileSync(join(dir, 'AGENT_CONTEXT.md'), 'utf8'), '# My own context\n');
  assert.ok(existsSync(join(dir, '.iwsdk-agent-kit-backups')));
  assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /iwsdk-agent-kit-backups/);
});
test('handoff content is factual and failure hints are advisory', () => {
  const state = { id: 'demo', backend: 'codex', baseline: 'abc123', directory: '/tmp/checkpoints' };
  const f = { ...feature(), status: 'failed', backend: 'muse', branch: 'agents/demo/first',
    worktree: '/tmp/worktree', error: 'usage exhausted' };
  const note = renderHandoff(state, f, { head: 'deadbeef', status: ' M src/a.ts', summary: 'Incomplete tests' });
  assert.match(note, /Incomplete tests/);
  assert.match(note, /Current commit: deadbeef/);
  assert.match(note, /usage exhausted/);
  assert.match(handoffPath(state, f), /handoffs\/first\.md$/);
  assert.equal(classifyFailure('Error: rate limit exceeded'), 'possible-usage-limit');
  assert.equal(classifyFailure('Permission denied'), 'permission-or-auth');
  assert.equal(classifyFailure('Syntax error'), 'unclassified');
});
test('failed feature can be handed to Muse without losing its task checkpoint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iwsdk-muse-batch-'));
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test User');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'package.json'), '{"name":"sample","scripts":{"test":"node --test"}}\n');
  writeFileSync(join(dir, 'AGENT_CONTEXT.md'), '# Project facts\nConfirmed SDK setup.\n');
  writeFileSync(join(dir, 'features.json'), JSON.stringify({ id: 'handoff-demo', features: [feature()] }));
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'initial');
  await main(['plan', 'features.json', '--backend', 'codex'], dir);
  const statePath = join(dir, '.git', 'agent-workflow', 'batches', 'handoff-demo', 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.match(sharedContext(state), /Confirmed SDK setup/);
  state.features[0].status = 'failed';
  state.features[0].error = 'codex exited 1 (possible-usage-limit)';
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  await assert.rejects(main(['handoff', 'handoff-demo', 'first', '--backend', 'muse'], dir), /Explicit authorization/);
  await main(['handoff', 'handoff-demo', 'first', '--backend', 'muse', '--approve'], dir);
  const updated = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(updated.features[0].status, 'pending');
  assert.equal(updated.features[0].backend, 'muse');
  assert.equal(updated.features[0].handoffs.length, 1);
  const checkpoint = readFileSync(join(dir, '.git', 'agent-workflow', 'batches', 'handoff-demo', 'handoffs', 'first.md'), 'utf8');
  assert.match(checkpoint, /possible-usage-limit/);
  assert.match(checkpoint, /codex/);
  assert.match(checkpoint, /Build one independent feature/);
});

test('handoff refuses dirty partial work without deleting it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iwsdk-dirty-handoff-'));
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test User');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'package.json'), '{"name":"sample"}\n');
  writeFileSync(join(dir, 'features.json'), JSON.stringify({ id: 'dirty-batch', features: [feature()] }));
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'initial');
  await main(['plan', 'features.json'], dir);
  const statePath = join(dir, '.git', 'agent-workflow', 'batches', 'dirty-batch', 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const worktree = state.features[0].worktree;
  mkdirSync(join(worktree, '..'), { recursive: true });
  git(dir, 'worktree', 'add', '-b', state.features[0].branch, worktree, state.baseline);
  mkdirSync(join(worktree, 'src', 'feature'), { recursive: true });
  const partial = join(worktree, 'src', 'feature', 'partial.ts');
  writeFileSync(partial, 'export const unfinished = true;\n');
  state.features[0].status = 'failed';
  state.features[0].error = 'usage limit';
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  await assert.rejects(
    main(['handoff', 'dirty-batch', 'first', '--backend', 'muse', '--approve'], dir),
    /Uncommitted work preserved/
  );
  assert.ok(existsSync(partial));
  const updated = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(updated.features[0].status, 'failed');
  assert.equal(updated.features[0].backend, undefined);
  assert.ok(existsSync(join(dir, '.git', 'agent-workflow', 'batches', 'dirty-batch', 'handoffs', 'first.md')));
});
