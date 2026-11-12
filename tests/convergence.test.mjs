import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConductorConfig, validateConvergenceConfig } from '../src/conductor-config.mjs';
import { runTargetedTests } from '../src/specialists.mjs';
import { runRegressionProof, failureReport, observeFailure, repairContext, canRepair } from '../src/convergence.mjs';
import { parseBatch, main } from '../src/orchestrator.mjs';
import { conduct } from '../src/conductor.mjs';

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function fixture(expected = 42, maxRepairs = 2) {
  const repo = mkdtempSync(join(tmpdir(), 'iwsdk-v08-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Convergence Tests');
  git(repo, 'config', 'user.email', 'convergence@example.invalid');
  mkdirSync(join(repo, 'src'));
  mkdirSync(join(repo, 'tests'));
  const cfg = validateConductorConfig({
    enabled: true, provider: 'codex', aiPlanning: false, aiVerification: false,
    maxWorkerStarts: 5, maxRetriesPerFeature: 0,
    specialists: { enabled: true, explore: false, check: true },
    convergence: { enabled: true, maxRepairsPerFeature: maxRepairs },
  });
  writeFileSync(join(repo, 'iwsdk-agent-kit.config.json'), JSON.stringify({
    backend: 'codex', providerIsolation: 'strict', conductor: cfg,
  }));
  writeFileSync(join(repo, 'src', 'main.mjs'), 'export const answer = 41;\n');
  writeFileSync(join(repo, 'tests', 'regression.test.mjs'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { answer } from '../src/main.mjs';",
    "test('regression: answer', () => assert.equal(answer, " + expected + "));",
    '',
  ].join('\n'));
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'baseline with reproducing test');
  const baseline = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'branch', '-m', 'agents/demo/toy');
  writeFileSync(join(repo, 'src', 'main.mjs'), 'export const answer = 42;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'fix value');
  const head = git(repo, 'rev-parse', 'HEAD');
  const directory = join(repo, '.git', 'agent-workflow', 'batches', 'demo');
  mkdirSync(join(directory, 'toy', '1'), { recursive: true });
  writeFileSync(join(directory, 'toy', '1', 'summary.md'), 'Attempt 1 changed the value.\n');
  const feature = {
    id: 'toy', description: 'Fix answer', interfaces: 'none', owns: ['src/'],
    acceptance: ['answer is correct'], contentChanges: false, runtimeRequired: false,
    targetedTests: ['tests/regression.test.mjs'], regressionTests: ['tests/regression.test.mjs'],
    dependsOn: [], status: 'completed', attempt: 1, startHead: baseline, head,
    worktree: repo, branch: 'agents/demo/toy', attemptDirectory: join(directory, 'toy', '1'),
  };
  const state = { id: 'demo', repo, directory, baseline, backend: 'codex',
    features: [feature], conductor: { enabled: true, convergenceEnabled: true,
      priority: ['toy'] } };
  writeFileSync(join(directory, 'state.json'), JSON.stringify(state));
  return { repo, directory, baseline, head, feature, state, cfg };
}

test('v0.8 is disabled by default, with strict bounds and unchanged manual plans', () => {
  assert.equal(validateConductorConfig({}).convergence.enabled, false);
  assert.equal(validateConvergenceConfig().maxRepairsPerFeature, 1);
  for (const input of [{ enabled: true, maxRepairsPerFeature: 3 },
    { enabled: true, maxFeedbackChars: 20000 }, { enabled: 'yes' }, { enabled: true, autoMerge: true }]) {
    assert.throws(() => validateConvergenceConfig(input), /convergence/);
  }
  assert.throws(() => validateConductorConfig({ convergence: { enabled: true } }), /requires enabled conductor/);
  assert.throws(() => validateConductorConfig({ enabled: true,
    convergence: { enabled: true }, specialists: { enabled: true, check: false } }), /requires enabled conductor/);
  const feature = { id: 'toy', description: 'Fix', owns: ['src/'], acceptance: ['works'],
    interfaces: 'none', contentChanges: false, runtimeRequired: false };
  assert.equal(parseBatch({ id: 'manual', features: [feature] }).features[0].regressionTests, undefined);
  assert.throws(() => parseBatch({ id: 'manual', features: [{
    ...feature, targetedTests: ['tests/a.test.mjs'], regressionTests: ['tests/b.test.mjs'],
  }] }), /regressionTests/);
  assert.throws(() => parseBatch({ id: 'manual', features: [{
    ...feature, targetedTests: ['tests/a.test.mjs'], regressionTests: ['../secret.test.mjs'],
  }] }), /targetedTests/);
});

test('baseline red + unchanged test + fixed head green produces commit-bound proof', () => {
  const { state, feature, baseline, head, directory } = fixture();
  const headTests = runTargetedTests(state, feature, 10);
  assert.equal(headTests[0].status, 'passed');
  const proof = runRegressionProof(state, feature, headTests, 10);
  assert.equal(proof.status, 'verified', JSON.stringify(proof));
  assert.equal(proof.baseline, baseline);
  assert.equal(proof.head, head);
  assert.equal(proof.baselineTests[0].status, 'failed');
  assert.equal(proof.headTests[0].status, 'passed');
  assert.ok(existsSync(join(directory, proof.baselineTests[0].log)));
  assert.ok(existsSync(join(directory, 'conductor', 'regression', 'toy', head + '.json')));
  assert.deepEqual(runRegressionProof(state, feature, headTests, 10), proof);
  assert.match(proof.caveat, /not automatic acceptance/);
});

test('changed regression test is not accepted as comparable red-green proof', () => {
  const { state, feature, repo } = fixture();
  writeFileSync(join(repo, 'tests', 'regression.test.mjs'), "import test from 'node:test'; test('changed', () => {});\n");
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'change test');
  feature.head = git(repo, 'rev-parse', 'HEAD');
  const headTests = runTargetedTests(state, feature, 10);
  const proof = runRegressionProof(state, feature, headTests, 10);
  assert.equal(proof.status, 'unavailable');
  assert.match(proof.reason, /identical/);
});

test('failure reports contain bounded deterministic expected/observed and SHA-bound logs', () => {
  const { state, feature, directory } = fixture(43);
  const tests = runTargetedTests(state, feature, 10);
  assert.equal(tests[0].status, 'failed');
  const report = failureReport(state, feature, tests);
  assert.match(report.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(report.head, feature.head);
  assert.equal(report.failures[0].test, 'tests/regression.test.mjs');
  assert.match(report.failures[0].observed, /42|regression|error/i);
  assert.ok(report.failures[0].log.includes(feature.head));
  const conductor = {};
  let persists = 0;
  const saved = observeFailure(state, conductor, feature, tests,
    { convergence: { maxFeedbackChars: 900 } }, () => { persists++; });
  assert.equal(persists, 1);
  assert.equal(saved.repeated, false);
  assert.equal(conductor.convergenceRuns.toy.observations.length, 1);
  feature.repairBaseHead = feature.head;
  assert.match(repairContext(state, feature), /Deterministic repair feedback/);
  state.conductor.convergenceEnabled = false;
  assert.equal(repairContext(state, feature), '');
  const log = join(directory, tests[0].log);
  writeFileSync(log, 'tampered');
  assert.throws(() => failureReport(state, feature, tests), /changed/);
});

test('same failure on a new commit stops rather than spending a second repair', () => {
  const { repo, state, feature, cfg } = fixture(43);
  const conductor = {};
  const first = runTargetedTests(state, feature, 10);
  const one = observeFailure(state, conductor, feature, first, cfg, () => {});
  assert.equal(one.repeated, false);
  writeFileSync(join(repo, 'src', 'main.mjs'), 'export const answer = 42; // same bug\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'attempted repair without effect');
  feature.head = git(repo, 'rev-parse', 'HEAD');
  const second = runTargetedTests(state, feature, 10);
  const two = observeFailure(state, conductor, feature, second, cfg, () => {});
  assert.equal(two.fingerprint, one.fingerprint);
  assert.equal(two.repeated, true);
  assert.match(canRepair(state, conductor, feature, two, cfg).reason, /repeated/);
  assert.equal(conductor.convergenceRuns.toy.observations.length, 2);
  assert.equal(observeFailure(state, conductor, feature, second, cfg, () => {}).repeated, true);
  assert.ok(existsSync(join(state.directory, first[0].log)), 'previous commit log retained');
  assert.ok(existsSync(join(state.directory, second[0].log)), 'new commit log retained');
});

test('conductor queues a single safe repair without a model call or evidence approval', async () => {
  const { repo, directory, state, feature } = fixture(43);
  const report = await conduct(repo, 'demo', ['--approve']);
  assert.equal(report.phase, 'repair-queued', JSON.stringify(report));
  assert.equal(report.convergence.features.toy.repairs, 1);
  const updated = JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8'));
  assert.equal(updated.features[0].status, 'pending');
  assert.equal(updated.features[0].repairBaseHead, feature.head);
  assert.equal(updated.features[0].repairCount, 1);
  assert.equal(existsSync(join(directory, 'acceptance-ledger.json')), true);
  assert.equal(existsSync(join(directory, 'conductor', 'feedback', 'toy.json')), true);
  const conductor = JSON.parse(readFileSync(join(directory, 'conductor.json'), 'utf8'));
  assert.equal(conductor.specialistRuns.calls.length, 0, 'failed tests must not consume paid checker calls');
  assert.equal(conductor.convergenceRuns.toy.observations.length, 1);
});

test('repeat failure after one repair stops with no extra worker or reviewer call', async () => {
  const { repo, directory, state, feature } = fixture(43);
  const first = await conduct(repo, 'demo', ['--approve']);
  assert.equal(first.phase, 'repair-queued');
  writeFileSync(join(repo, 'src', 'main.mjs'), 'export const answer = 42; // unchanged failure\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'repair attempt');
  const next = JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8'));
  next.features[0].head = git(repo, 'rev-parse', 'HEAD');
  next.features[0].status = 'completed';
  next.features[0].attempt = 2;
  next.features[0].attemptDirectory = join(directory, 'toy', '2');
  mkdirSync(next.features[0].attemptDirectory, { recursive: true });
  writeFileSync(join(next.features[0].attemptDirectory, 'summary.md'), 'Repair attempt complete\n');
  writeFileSync(join(directory, 'state.json'), JSON.stringify(next));
  const second = await conduct(repo, 'demo', ['--approve']);
  assert.equal(second.phase, 'convergence-stopped');
  assert.equal(second.convergence.features.toy.repairs, 1);
  const stopped = JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8'));
  assert.equal(stopped.features[0].status, 'completed');
  assert.equal(JSON.parse(readFileSync(join(directory, 'conductor.json'), 'utf8'))
    .convergenceRuns.toy.observations.length, 2);
});

test('repair command rejects manual mode, dirty worktrees and unapproved calls', async () => {
  const { repo, directory, state, feature } = fixture(43);
  await assert.rejects(main(['repair', 'demo', 'toy'], repo), /--approve/);
  await assert.rejects(main(['repair', 'demo', 'toy', '--approve'], repo), /snapshot required/);
  const snapshot = { config: validateConductorConfig({ enabled: true, provider: 'codex',
    specialists: { enabled: true }, convergence: { enabled: true } }),
    convergenceRuns: { toy: { observations: [] } } };
  writeFileSync(join(directory, 'conductor.json'), JSON.stringify(snapshot));
  await assert.rejects(main(['repair', 'demo', 'toy', '--approve'], repo), /feedback required/);
  state.conductor.convergenceEnabled = false;
  writeFileSync(join(directory, 'state.json'), JSON.stringify(state));
  await assert.rejects(main(['repair', 'demo', 'toy', '--approve'], repo), /opted-in/);
  assert.equal(JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8')).features[0].status, 'completed');
});

test('repair rejects dirty worktrees, started dependents, ownership changes and spent budgets', async () => {
  const { repo, directory, state, feature, cfg } = fixture(43);
  const tests = runTargetedTests(state, feature, 10);
  const conductor = {};
  observeFailure(state, conductor, feature, tests, cfg, () => {});
  writeFileSync(join(directory, 'conductor.json'), JSON.stringify({
    config: cfg, convergenceRuns: conductor.convergenceRuns,
  }));
  writeFileSync(join(repo, 'untracked.txt'), 'do not discard me\n');
  await assert.rejects(main(['repair', 'demo', 'toy', '--approve'], repo), /unchanged clean feature branch/);
  assert.equal(readFileSync(join(repo, 'untracked.txt'), 'utf8'), 'do not discard me\n');
  const { unlinkSync } = await import('node:fs');
  unlinkSync(join(repo, 'untracked.txt'));

  state.features.push({ id: 'dependent', status: 'running', dependsOn: ['toy'],
    attempt: 0, backend: 'codex' });
  writeFileSync(join(directory, 'state.json'), JSON.stringify(state));
  await assert.rejects(main(['repair', 'demo', 'toy', '--approve'], repo), /Dependent feature already started/);
  state.features.pop();

  state.features[0].owns = ['tests/'];
  writeFileSync(join(directory, 'state.json'), JSON.stringify(state));
  await assert.rejects(main(['repair', 'demo', 'toy', '--approve'], repo), /ownership violation/);
  state.features[0].owns = ['src/'];

  state.features[0].repairCount = cfg.convergence.maxRepairsPerFeature;
  writeFileSync(join(directory, 'state.json'), JSON.stringify(state));
  await assert.rejects(main(['repair', 'demo', 'toy', '--approve'], repo), /budget is exhausted/);
  assert.equal(JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8')).features[0].status, 'completed');
});
