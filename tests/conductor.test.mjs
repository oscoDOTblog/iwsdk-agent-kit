import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConductorConfig, readConductorConfig, resolveConductorProvider } from '../src/conductor-config.mjs';
import { plannerPrompt, verifierPrompt, validatePlanner, validateVerifier,
  coordinatorInvocation, runCoordinatorRole } from '../src/conductor-ai.mjs';
import { syncEvidence, recordEvidence, inspectEvidence } from '../src/evidence.mjs';
import { conduct, conductorStatus } from '../src/conductor.mjs';
import { main, ready, parseBatch } from '../src/orchestrator.mjs';
import { install } from '../src/install.mjs';

const temp = name => mkdtempSync(join(tmpdir(), name));
function git(root, ...args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function project({ enabled = true, aiPlanning = false, aiVerification = false,
  provider = 'claude', maxWorkerStarts = 3 } = {}) {
  const root = temp('iwsdk-conductor-');
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Conductor Test');
  git(root, 'config', 'user.email', 'conductor@example.invalid');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'conductor-test', scripts: { test: 'node --test' } }));
  writeFileSync(join(root, 'iwsdk-agent-kit.config.json'), JSON.stringify({
    backend: 'codex', baseBranch: 'main', providerIsolation: 'strict',
    conductor: { enabled, provider, aiPlanning, aiVerification, maxWorkerStarts },
  }));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'baseline');
  return root;
}
const feature = () => ({
  id: 'toy', description: 'Implement a toy', owns: ['src/toys/'],
  acceptance: ['Automated interaction test passed', 'Manual headset check passed'],
  interfaces: 'none', contentChanges: false, runtimeRequired: true,
});
async function plan(root, id = 'demo') {
  writeFileSync(join(root, 'batch.json'), JSON.stringify({ id, features: [feature()] }));
  await main(['plan', 'batch.json'], root);
  const directory = join(root, '.git', 'agent-workflow', 'batches', id);
  return { directory, statePath: join(directory, 'state.json') };
}
function finishFeature(root, statePath) {
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const f = state.features[0];
  mkdirSync(join(f.worktree, '..'), { recursive: true });
  git(root, 'worktree', 'add', '-b', f.branch, f.worktree, state.baseline);
  mkdirSync(join(f.worktree, 'src', 'toys'), { recursive: true });
  writeFileSync(join(f.worktree, 'src', 'toys', 'toy.txt'), 'done\n');
  git(f.worktree, 'add', '.');
  git(f.worktree, 'commit', '-m', 'add toy');
  f.startHead = state.baseline;
  f.head = git(f.worktree, 'rev-parse', 'HEAD');
  f.status = 'completed';
  f.attempt = 1;
  f.attemptDirectory = join(state.directory, 'toy', '1');
  mkdirSync(f.attemptDirectory, { recursive: true });
  writeFileSync(join(f.attemptDirectory, 'summary.md'), 'Implemented and committed toy');
  writeFileSync(join(f.attemptDirectory, 'test.log'), 'PASS: toy interaction\n');
  writeFileSync(statePath, JSON.stringify(state));
  return state;
}
test('conductor is opt-in, bounded and never permits auto integration', () => {
  assert.equal(validateConductorConfig({}).enabled, false);
  assert.equal(validateConductorConfig({ enabled: true }).maxParallelWorkers, 2);
  assert.throws(() => validateConductorConfig({ autoIntegrate: true }), /cannot auto-integrate/);
  assert.throws(() => validateConductorConfig({ maxWorkerStarts: 0 }), /integer between/);
  assert.throws(() => validateConductorConfig({ maxRetriesPerFeature: 5 }), /integer between/);
  assert.throws(() => validateConductorConfig({ provider: 'opencode' }), /only for Claude and Codex/);
  assert.throws(() => validateConductorConfig({ models: { implementer: 'opus' } }), /Unsupported conductor model role/);
  assert.throws(() => validateConductorConfig({ unexpected: true }), /Unknown conductor setting/);
});
test('planner cannot change approved task set or invent test results', () => {
  const state = { id: 'demo', directory: temp('iwsdk-planner-ledger-'), features: [
    { ...feature(), dependsOn: [] },
    { ...feature(), id: 'npc', dependsOn: ['toy'] },
  ] };
  const prompt = plannerPrompt(state);
  assert.match(prompt, /read-only coordinator/);
  assert.match(prompt, /dependencies/);
  assert.deepEqual(validatePlanner({ priority: ['npc', 'toy'], risks: [], notes: '' }, state).priority, ['npc', 'toy']);
  assert.throws(() => validatePlanner({ priority: ['npc', 'npc'], risks: [], notes: '' }, state), /every existing feature/);
  assert.throws(() => validatePlanner({ priority: ['npc', 'extra'], risks: [], notes: '' }, state), /every existing feature/);
  const review = verifierPrompt(state, syncEvidence(state));
  assert.match(review, /Do NOT mark any criterion passed/);
  assert.throws(() => validateVerifier({ findings: [{ feature: 'other', severity: 'high', summary: 'x' }], summary: '' }, state), /Invalid verifier/);
  assert.deepEqual(validateVerifier({ findings: [], summary: 'Review manually' }, state).findings, []);
});
test('model invocations are no-tools for Claude and read-only for Codex', () => {
  const claude = coordinatorInvocation('claude', 'claude-fable-5-2', 'Prompt', '/tmp/last');
  assert.ok(claude.args.includes('--tools'));
  assert.equal(claude.args[claude.args.indexOf('--tools') + 1], '');
  assert.ok(claude.args.includes('claude-fable-5-2'));
  const codex = coordinatorInvocation('codex', 'gpt-5.3-codex', 'Prompt', '/tmp/last');
  assert.deepEqual(codex.args.slice(codex.args.indexOf('--sandbox'), codex.args.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);
  assert.ok(codex.args.includes('agents.enabled=false'));
  assert.throws(() => coordinatorInvocation('opencode', null, 'Prompt', '/tmp/last'), /Unsupported/);
});
test('coordinator parses model output but cannot dispatch model-suggested commands', () => {
  const directory = temp('iwsdk-ai-');
  const state = { id: 'demo', repo: directory, directory, features: [{ ...feature(), dependsOn: [] }] };
  const cfg = validateConductorConfig({ enabled: true, models: { planner: 'claude-fable-5-2' } });
  const result = runCoordinatorRole(state, cfg, 'planner', plannerPrompt(state), {
    execute: (command, args, options) => {
      assert.equal(command, 'claude');
      assert.equal(options.cwd, directory);
      return { status: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success',
        result: JSON.stringify({ priority: ['toy'], risks: [], notes: 'Safe' }),
        usage: { input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }) };
    },
  });
  assert.deepEqual(result.data.priority, ['toy']);
  assert.equal(result.usage.inputTokens, 12);
  assert.ok(existsSync(join(directory, 'conductor', 'planner.jsonl')));
  assert.throws(() => runCoordinatorRole(state, cfg, 'planner', 'Prompt', {
    execute: () => ({ status: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success',
      result: JSON.stringify({ priority: ['bad'], risks: [], notes: '' }) }) }),
  }), /every existing feature/);
});
test('manual mode stays unchanged; conductor requires explicit config and approval', async () => {
  const root = project({ enabled: false });
  await plan(root);
  assert.equal(conductorStatus(root, 'demo').mode, 'manual');
  await assert.rejects(conduct(root, 'demo', ['--approve']), /disabled/);
  const enabledRoot = project();
  await plan(enabledRoot);
  await assert.rejects(conduct(enabledRoot, 'demo'), /--approve/);
  assert.equal(conductorStatus(enabledRoot, 'demo').mode, 'manual');
});
test('AI coordinator provider is independently guarded by strict provider isolation', async () => {
  const root = project({ aiPlanning: true, aiVerification: true });
  await plan(root);
  await assert.rejects(conduct(root, 'demo', ['--approve']), /Provider isolation blocked conduct/);
  assert.equal(conductorStatus(root, 'demo').mode, 'manual');
});
test('conductor pauses on exhausted worker-start budget without launching a model', async () => {
  const root = project({ maxWorkerStarts: 1 });
  const { statePath } = await plan(root);
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  state.features[0].attempt = 1;
  state.features[0].status = 'failed';
  state.features[0].error = 'usage limit reached';
  writeFileSync(statePath, JSON.stringify(state));
  const report = await conduct(root, 'demo', ['--approve']);
  assert.equal(report.phase, 'budget-exhausted');
  assert.equal(report.workerStarts, 1);
  assert.equal(conductorStatus(root, 'demo').phase, 'budget-exhausted');
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).features[0].status, 'failed');
});
test('conductor is resumable and never self-approves acceptance or integrates', async () => {
  const root = project();
  const { statePath } = await plan(root);
  const state = finishFeature(root, statePath);
  const first = await conduct(root, 'demo', ['--approve']);
  assert.equal(first.phase, 'awaiting-evidence');
  assert.equal(first.evidence.complete, false);
  await assert.rejects(main(['collect', 'demo'], root), /requires current acceptance evidence/);
  for (const i of [1, 2]) {
    await main(['evidence', 'demo', 'toy', String(i), '--status', 'passed', '--kind',
      i === 1 ? 'test' : 'runtime', '--artifact', 'toy/1/test.log',
      '--note', i === 1 ? 'Reviewed automated test log' : 'Reviewed headset session', '--approve'], root);
  }
  const resumed = await conduct(root, 'demo', ['--approve']);
  assert.equal(resumed.phase, 'ready-for-collection');
  assert.equal(resumed.evidence.complete, true);
  assert.equal(resumed.workerStarts, 1);
  assert.ok(!existsSync(join(state.directory, 'collection.json')));
  await main(['collect', 'demo'], root);
  assert.ok(existsSync(join(state.directory, 'collection.json')));
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).features[0].status, 'collected');
  writeFileSync(join(state.directory, 'toy', '1', 'test.log'), 'ALTERED\n');
  assert.equal(inspectEvidence(JSON.parse(readFileSync(statePath, 'utf8'))).complete, false);
  await assert.rejects(main(['integrate', 'demo', '--approve'], root), /evidence is missing or stale/);
});
test('resume reconciles an already-running worker without a second launch after budget exhaustion', async () => {
  const root = project({ maxWorkerStarts: 1 });
  const { statePath } = await plan(root);
  const state = finishFeature(root, statePath);
  const f = state.features[0];
  f.status = 'running';
  f.pid = process.pid; // Simulates a still-alive detached worker wrapper.
  writeFileSync(statePath, JSON.stringify(state));
  const active = await conduct(root, 'demo', ['--approve']);
  assert.equal(active.phase, 'running');
  assert.equal(active.workerStarts, 1);
  writeFileSync(join(f.attemptDirectory, 'receipt.json'), JSON.stringify({
    status: 'completed', head: f.head, endedAt: new Date().toISOString(),
  }));
  const resumed = await conduct(root, 'demo', ['--approve']);
  assert.equal(resumed.phase, 'awaiting-evidence');
  assert.equal(resumed.workerStarts, 1);
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).features[0].status, 'completed');
});
test('evidence cannot be forged with missing artifacts, changed commits, or path escapes', () => {
  const root = project();
  const state = { id: 'demo', directory: join(root, '.git'), features: [
    { ...feature(), status: 'completed', head: git(root, 'rev-parse', 'HEAD'), worktree: root },
  ] };
  assert.throws(() => recordEvidence(state, 'toy', 1, {
    status: 'passed', kind: 'test', artifact: '../outside', note: 'Reviewed',
  }), /relative path/);
  assert.throws(() => recordEvidence(state, 'toy', 1, {
    status: 'passed', kind: 'test', artifact: 'missing.log', note: 'Reviewed',
  }), /existing regular file/);
  assert.throws(() => recordEvidence(state, 'toy', 3, {
    status: 'passed', kind: 'test', artifact: 'missing.log', note: 'Reviewed',
  }), /1-based acceptance index/);
});
test('installer exposes conductor commands and copies modules without enabling conductor', () => {
  const root = project({ enabled: false });
  install(root);
  for (const name of ['conductor.mjs', 'conductor-ai.mjs', 'conductor-config.mjs', 'evidence.mjs']) {
    assert.ok(existsSync(join(root, 'scripts', name)));
  }
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['agents:conduct'], 'node scripts/agents.mjs conduct');
  assert.equal(pkg.scripts['agents:conduct-status'], 'node scripts/agents.mjs conduct-status');
  assert.equal(pkg.scripts['agents:evidence'], 'node scripts/agents.mjs evidence');
  assert.equal(readConductorConfig(root).enabled, false);
});
test('conductor prioritization never bypasses feature dependencies', () => {
  const state = { conductor: { enabled: true, priority: ['npc', 'toy'] }, features: [
    { id: 'toy', status: 'pending', dependsOn: [] },
    { id: 'npc', status: 'pending', dependsOn: ['toy'] },
  ] };
  assert.deepEqual(ready(state).map(f => f.id), ['toy']);
  state.features[0].status = 'completed';
  assert.deepEqual(ready(state).map(f => f.id), ['npc']);
  const parsed = parseBatch({ id: 'demo', features: [
    { ...feature(), id: 'toy' }, { ...feature(), id: 'npc', owns: ['src/npc/'], dependsOn: ['toy'] },
  ] });
  assert.equal(parsed.features[1].dependsOn[0], 'toy');
});

test('conductor auto AI roles follow only supported harnesses and retain all budget validation', () => {
  const auto = validateConductorConfig({ enabled: true, provider: 'auto' });
  assert.equal(resolveConductorProvider(auto, { backend: 'claude' }).provider, 'claude');
  assert.equal(resolveConductorProvider(auto, { backend: 'codex' }).provider, 'codex');
  assert.throws(() => resolveConductorProvider(auto, null), /needs a detected coordinator/);
  assert.throws(() => resolveConductorProvider(auto, { backend: 'muse' }), /only for Claude and Codex/);
  assert.throws(() => resolveConductorProvider(auto, { backend: 'opencode' }), /only for Claude and Codex/);
  const noAi = validateConductorConfig({ enabled: true, provider: 'auto',
    aiPlanning: false, aiVerification: false });
  assert.equal(resolveConductorProvider(noAi, { backend: 'muse' }).provider, 'auto');
  assert.equal(resolveConductorProvider(noAi, null).provider, 'auto');
  assert.throws(() => validateConductorConfig({ provider: 'auto', models: { planner: 'opus' } }), /cannot be pinned/);
  assert.throws(() => validateConductorConfig({ provider: 'auto', maxWorkerStarts: 0 }), /integer between/);
  assert.throws(() => validateConductorConfig({ provider: 'auto', autoIntegrate: true }), /cannot auto-integrate/);
  assert.throws(() => validateConductorConfig({ provider: 'auto', models: [] }), /must be a map/);
});
