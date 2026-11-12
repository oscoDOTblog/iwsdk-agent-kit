import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConductorConfig } from '../src/conductor-config.mjs';
import { validateTargetedTests, validateInvestigation, investigationPrompt, investigationContext,
  specialistInvocation, runSpecialist, saveInvestigation, captureFeatureDiff,
  runTargetedTests, checkerPrompt, validateChecker, saveCheck } from '../src/specialists.mjs';
import { specialistRuns, canInvoke } from '../src/specialist-conductor.mjs';
import { readBatchUsage } from '../src/usage.mjs';
import { main, resolveWorkerModel } from '../src/orchestrator.mjs';

const temp = () => mkdtempSync(join(tmpdir(), 'iwsdk-specialists-'));
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function fixture() {
  const repo = temp();
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Specialist Tests');
  git(repo, 'config', 'user.email', 'specialists@example.invalid');
  mkdirSync(join(repo, 'src'));
  mkdirSync(join(repo, 'tests'));
  writeFileSync(join(repo, 'src', 'main.mjs'), 'export const answer = 41;\n');
  writeFileSync(join(repo, 'tests', 'feature.test.mjs'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { answer } from '../src/main.mjs';",
    "test('answer is 42', () => assert.equal(answer, 42));",
    '',
  ].join('\n'));
  writeFileSync(join(repo, 'package.json'), '{"name":"specialist-test","type":"module"}\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'baseline');
  const startHead = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'src', 'main.mjs'), 'export const answer = 42;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'implement feature');
  const head = git(repo, 'rev-parse', 'HEAD');
  const directory = join(repo, '.git', 'agent-workflow', 'batches', 'demo');
  mkdirSync(directory, { recursive: true });
  const feature = { id: 'toy', worktree: repo, head, startHead,
    description: 'Fix answer', owns: ['src/'], acceptance: ['answer is 42'],
    interfaces: 'none', runtimeRequired: false, targetedTests: ['tests/feature.test.mjs'] };
  const state = { id: 'demo', repo, directory, baseline: startHead, features: [feature],
    backend: 'claude' };
  return { repo, directory, feature, state };
}
const cfg = () => validateConductorConfig({ enabled: true, provider: 'claude',
  specialists: { enabled: true, models: { explorer: 'haiku', fixer: 'sonnet', checker: 'sonnet' } } });

test('specialist profiles are disabled by default and validated independently', () => {
  assert.equal(validateConductorConfig({}).specialists.enabled, false);
  assert.equal(cfg().specialists.maxCalls, 12);
  assert.throws(() => validateConductorConfig({ specialists: { enabled: true, maxCalls: 0 } }), /maxCalls/);
  assert.throws(() => validateConductorConfig({ specialists: { models: { publisher: 'opus' } } }), /Unsupported specialist model role/);
  assert.throws(() => validateConductorConfig({ specialists: { models: { explorer: 'bad model' } } }), /Invalid worker model/);
  assert.throws(() => validateConductorConfig({ specialists: { autoIntegrate: true } }), /Unknown conductor.specialists/);
  assert.throws(() => validateConductorConfig({ autoIntegrate: true, specialists: { enabled: true } }), /cannot auto-integrate/);
});

test('only approved, relative test files are allowed; shell commands cannot be injected', () => {
  assert.deepEqual(validateTargetedTests(undefined), []);
  assert.deepEqual(validateTargetedTests(['tests/feature.test.mjs']), ['tests/feature.test.mjs']);
  for (const value of [['../secret.test.mjs'], ['/tmp/a.test.mjs'],
    ['tests/x.test.mjs; rm -rf /'], ['tests/*.test.mjs'], ['tests/x.test.mjs', 'tests/x.test.mjs']]) {
    assert.throws(() => validateTargetedTests(value), /targetedTests/);
  }
});

test('explorer and checker have read-only tools and cannot spawn nested agents', () => {
  const explorer = specialistInvocation('claude', 'explorer', 'haiku', 'Inspect', '/tmp/out');
  assert.ok(explorer.args.includes('Read,Grep,Glob'));
  assert.ok(explorer.args.includes('Agent,mcp__*'));
  assert.ok(!explorer.args.includes('Edit'));
  const checker = specialistInvocation('claude', 'checker', 'sonnet', 'Review', '/tmp/out');
  assert.equal(checker.args[checker.args.indexOf('--tools') + 1], 'Read,Grep,Glob');
  const codex = specialistInvocation('codex', 'checker', null, 'Review', '/tmp/out');
  assert.ok(codex.args.includes('read-only'));
  assert.ok(codex.args.includes('agents.enabled=false'));
  assert.throws(() => specialistInvocation('muse', 'explorer', null, '', ''), /Unsupported/);
});

test('explorer returns bounded, verified file references and a structured handoff', () => {
  const { state, feature } = fixture();
  const report = { summary: 'The implementation lives in src/main.mjs.', files: [
    { path: 'src/main.mjs', line: 1, reason: 'Defines the value' },
  ], risks: ['Callers may rely on the previous value'] };
  const prompt = investigationPrompt(state, feature);
  assert.match(prompt, /read-only code explorer/);
  assert.deepEqual(validateInvestigation(report, state).files[0].path, 'src/main.mjs');
  for (const files of [[{ path: '../secrets', line: 1, reason: 'bad' }],
    [{ path: 'src/main.mjs', line: 999, reason: 'bad' }],
    [{ path: 'src/missing.mjs', line: 1, reason: 'bad' }]]) {
    assert.throws(() => validateInvestigation({ ...report, files }, state), /reference|line|missing/);
  }
  const result = { data: report, provider: 'claude', model: 'haiku', usage: { inputTokens: 5 } };
  saveInvestigation(state, feature, result);
  assert.equal(investigationContext(state, feature), '');
  state.conductor = { enabled: true };
  assert.match(investigationContext(state, feature), /src\/main\.mjs/);
  state.baseline = 'changed';
  assert.equal(investigationContext(state, feature), '');
});

test('specialist runner validates model result and records observed usage without fallback', () => {
  const { state, feature } = fixture();
  let calls = 0;
  const execute = (command, args, options) => {
    calls++;
    assert.equal(command, 'claude');
    assert.equal(options.cwd, state.repo);
    assert.ok(args.includes('--permission-mode'));
    return { status: 0, stdout: JSON.stringify({
      type: 'result', subtype: 'success',
      usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      result: JSON.stringify({ summary: 'Located source', files: [{ path: 'src/main.mjs', line: 1, reason: 'Entry point' }], risks: [] }),
    }) };
  };
  const result = runSpecialist(state, cfg(), 'explorer', feature, 'Inspect', { execute });
  assert.equal(calls, 1);
  assert.equal(result.usage.inputTokens, 12);
  assert.equal(result.data.files[0].line, 1);
  assert.ok(existsSync(join(state.directory, 'conductor', 'explorer', 'toy.jsonl')));
  assert.throws(() => runSpecialist(state, cfg(), 'explorer', feature, 'Inspect', {
    execute: () => ({ status: 1, stdout: 'failure' }),
  }), /no fallback or retry/);
});

test('checker receives actual commit diff, deterministic tests and SHA-bound artifacts', () => {
  const { state, feature, directory } = fixture();
  const diff = captureFeatureDiff(state, feature, 16000);
  assert.match(diff.patch, /answer = 42/);
  assert.equal(diff.head, feature.head);
  assert.equal(diff.truncated, false);
  const tests = runTargetedTests(state, feature, 20);
  assert.equal(tests.length, 1);
  assert.equal(tests[0].status, 'passed');
  assert.equal(tests[0].head, feature.head);
  assert.ok(readFileSync(join(directory, tests[0].log), 'utf8').includes('Exit: 0'));
  const prompt = checkerPrompt(feature, diff, tests);
  assert.match(prompt, /actual diff/i);
  assert.match(prompt, /answer = 42/);
  const result = { data: { verdict: 'pass', summary: 'No obvious regression in changed lines', findings: [] },
    provider: 'claude', model: 'sonnet', usage: { inputTokens: 100 } };
  const saved = saveCheck(state, feature, diff, tests, result);
  assert.equal(saved.status, 'pass');
  assert.equal(saved.diff.sha256, diff.sha256);
  assert.ok(existsSync(join(directory, 'conductor', 'checks', 'toy.json')));
  assert.equal(captureFeatureDiff(state, feature, 8).truncated, true);
  assert.throws(() => validateChecker(result.data, { ...diff, truncated: true }), /cannot pass/);
  assert.throws(() => validateChecker({ verdict: 'fail', summary: 'issue', findings: [
    { path: '../outside', line: 1, severity: 'high', detail: 'bad' },
  ] }, diff), /changed file/);
});

test('failed targeted tests are recorded, never reported as passing evidence', () => {
  const { state, feature } = fixture();
  const tests = runTargetedTests(state, feature, 20, {
    execute: () => ({ status: 1, stdout: 'not ok 1 - answer is 42', stderr: '' }),
  });
  assert.equal(tests[0].status, 'failed');
  assert.equal(tests[0].head, feature.head);
  const diff = captureFeatureDiff(state, feature, 16000);
  const saved = saveCheck(state, feature, diff, tests, { data: {
    verdict: 'pass', summary: 'Patch itself looks correct', findings: [],
  } });
  assert.equal(saved.status, 'failed-tests');
});

test('lifetime specialist limits count even interrupted starts', () => {
  const conductor = { specialistRuns: { calls: [
    { role: 'explorer', status: 'started' }, { role: 'checker', status: 'completed' },
  ], investigations: {}, checks: {} } };
  const config = validateConductorConfig({ specialists: { enabled: true,
    maxCalls: 2, maxExplorerCalls: 1, maxCheckerCalls: 1 } });
  assert.equal(canInvoke(conductor, config, 'explorer'), false);
  assert.equal(canInvoke(conductor, config, 'checker'), false);
  assert.equal(specialistRuns(conductor).calls.length, 2);
});

test('usage is grouped by role only for opted-in conductor; manual mode unchanged', () => {
  const { state, directory } = fixture();
  state.features[0].attempt = 1;
  state.features[0].status = 'completed';
  mkdirSync(join(directory, 'toy', '1'), { recursive: true });
  writeFileSync(join(directory, 'toy', '1', 'worker.jsonl'), JSON.stringify({
    type: 'result', usage: { input_tokens: 15, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }));
  assert.equal(readBatchUsage(state).roles, undefined);
  writeFileSync(join(directory, 'conductor.json'), JSON.stringify({
    config: { provider: 'claude', specialists: { enabled: true } },
    plan: { provider: 'claude', usage: { inputTokens: 2, outputTokens: 1 } },
    specialistRuns: { calls: [{ role: 'explorer', usage: { inputTokens: 8, outputTokens: 2 } },
      { role: 'checker', status: 'started' }] },
  }));
  const report = readBatchUsage(state);
  assert.equal(report.roles.find(x => x.role === 'fixer').inputTokens, 15);
  assert.equal(report.roles.find(x => x.role === 'explorer').inputTokens, 8);
  assert.equal(report.roles.find(x => x.role === 'checker').measuredCalls, 0);
  assert.equal(report.roles.find(x => x.role === 'planner').inputTokens, 2);
});

test('manual planning still makes no specialist calls or reports', async () => {
  const { repo } = fixture();
  writeFileSync(join(repo, 'iwsdk-agent-kit.config.json'), JSON.stringify({
    backend: 'codex', providerIsolation: 'strict', baseBranch: 'main',
    conductor: { enabled: false, specialists: { enabled: false } },
  }));
  writeFileSync(join(repo, 'batch.json'), JSON.stringify({ id: 'manual', features: [{
    id: 'fix', description: 'Fix a value', owns: ['src/main.mjs'],
    acceptance: ['answer is 42'], interfaces: 'none', contentChanges: false,
    runtimeRequired: false, targetedTests: ['tests/feature.test.mjs'],
  }] }));
  await main(['plan', 'batch.json'], repo);
  const directory = join(repo, '.git', 'agent-workflow', 'batches', 'manual');
  const state = JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8'));
  assert.equal(state.conductor, undefined);
  assert.equal(readBatchUsage(state).roles, undefined);
  assert.equal(existsSync(join(directory, 'conductor.json')), false);
  assert.equal(existsSync(join(directory, 'conductor', 'investigations')), false);
});

test('fixer model pin applies only to its own provider and manual worker remains unchanged', () => {
  const state = { promptSettings: { workerModels: { claude: 'default-claude', codex: 'default-codex' } } };
  assert.equal(resolveWorkerModel(state, 'claude'), 'default-claude');
  assert.equal(resolveWorkerModel(state, 'codex'), 'default-codex');
  state.conductor = { enabled: true, fixerProvider: 'claude', fixerModel: 'specialist-sonnet' };
  assert.equal(resolveWorkerModel(state, 'claude'), 'specialist-sonnet');
  assert.equal(resolveWorkerModel(state, 'codex'), 'default-codex');
});

test('checker invocation is isolated and sees only its own worktree', () => {
  const { state, feature } = fixture();
  const diff = captureFeatureDiff(state, feature, 16000);
  const result = runSpecialist(state, cfg(), 'checker', feature, checkerPrompt(feature, diff, []), {
    execute: (command, args, options) => {
      assert.equal(options.cwd, feature.worktree);
      assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob');
      assert.ok(!args.includes('Edit'));
      return { status: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success',
        result: JSON.stringify({ verdict: 'needs-human', summary: 'Headset test not run', findings: [] }) }) };
    },
  });
  assert.equal(validateChecker(result.data, diff).verdict, 'needs-human');
});
