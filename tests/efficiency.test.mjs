import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { extractUsage, summarizeUsage, readBatchUsage, formatUsageReport } from '../src/usage.mjs';
import { readPromptSettings, boundedText, stablePromptPrefix, buildWorkerPrompt } from '../src/prompt.mjs';
import { renderCompactHandoff, writeHandoff, compactHandoffContext } from '../src/handoff.mjs';
import { auditCacheConfig, formatCacheAudit } from '../src/cache-audit.mjs';
import { renderReviewPrompt, writeReviewPrompt } from '../src/review.mjs';
import { workerInvocation } from '../src/backends.mjs';
import { install } from '../src/install.mjs';

const dir = prefix => mkdtempSync(join(tmpdir(), prefix));
const feature = () => ({
  id: 'toy', description: 'Add one sandbox toy', owns: ['src/toys/'],
  acceptance: ['Works in headset'], interfaces: 'none',
  contentChanges: false, runtimeRequired: true, dependsOn: [],
  decisions: ['Keep the existing collision behavior'], status: 'failed',
  branch: 'agents/demo/toy', error: 'quota reached',
});
const jsonl = (...events) => events.map(e => JSON.stringify(e)).join('\n') + '\n';

test('Claude usage counts final aggregate only and distinguishes cached/uncached input', () => {
  const raw = jsonl({ type: 'assistant', usage: { input_tokens: 999999 } },
    { type: 'result', usage: { input_tokens: 100, output_tokens: 20,
      cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } });
  assert.deepEqual(extractUsage('claude', raw), {
    inputTokens: 1000, outputTokens: 20, cacheReadTokens: 900,
    cacheWriteTokens: 0, cacheHitRatio: 0.9,
  });
  assert.equal(extractUsage('claude', '{}').inputTokens, null);
});
test('Codex counts turn usage without double-counting cumulative token_count events', () => {
  const turns = jsonl(
    { type: 'turn.completed', usage: { input_tokens: 40, cached_input_tokens: 20, output_tokens: 5 } },
    { type: 'turn.completed', usage: { input_tokens: 60, cached_input_tokens: 40, output_tokens: 10 } });
  assert.equal(extractUsage('codex', turns).inputTokens, 100);
  assert.equal(extractUsage('codex', turns).cacheHitRatio, 0.6);
  const cumulative = turns + jsonl({ type: 'thread/token_count', info: {
    total_token_usage: { input_tokens: 120, cached_input_tokens: 70, output_tokens: 18 } } });
  assert.equal(extractUsage('codex', cumulative).inputTokens, 120);
});
test('OpenCode step usage is aggregated; unsupported Muse data remains unknown', () => {
  const raw = jsonl(
    { type: 'message.updated', part: { tokens: { input: 1000 } } },
    { type: 'step_finish', part: { tokens: { input: 20, output: 3, cache: { read: 5, write: 2 } } } },
    { type: 'step_finish', part: { tokens: { input: 30, output: 4, cache: { read: 8, write: 0 } } } });
  const result = extractUsage('opencode', raw);
  assert.equal(result.inputTokens, 50);
  assert.equal(result.outputTokens, 7);
  assert.equal(result.cacheReadTokens, 13);
  assert.equal(result.cacheHitRatio, null);
  assert.equal(extractUsage('muse', 'Done').inputTokens, null);
});
test('unknown attempts are not reported as zero and cross-provider attempts retain their origin', () => {
  const base = dir('iwsdk-usage-'), directory = join(base, 'batch');
  mkdirSync(join(directory, 'toy', '1'), { recursive: true });
  mkdirSync(join(directory, 'toy', '2'), { recursive: true });
  writeFileSync(join(directory, 'toy', '1', 'spec.json'), JSON.stringify({ state: { backend: 'claude' }, feature: {} }));
  writeFileSync(join(directory, 'toy', '1', 'worker.jsonl'), jsonl({ type: 'result', usage: {
    input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 } }));
  writeFileSync(join(directory, 'toy', '2', 'spec.json'), JSON.stringify({ state: { backend: 'codex' }, feature: {} }));
  const state = { id: 'demo', backend: 'codex', directory, features: [{ id: 'toy', attempt: 2, status: 'failed' }] };
  const report = readBatchUsage(state);
  assert.deepEqual(report.attempts.map(a => a.backend), ['claude', 'codex']);
  assert.equal(report.groups.find(g => g.backend === 'claude').inputTokens, 100);
  assert.equal(report.groups.find(g => g.backend === 'codex').inputTokens, null);
  assert.ok(report.groups.find(g => g.backend === 'codex').partialMetrics.includes('inputTokens'));
  assert.ok(report.groups.find(g => g.backend === 'claude').cacheHitRatio === 0.9);
  assert.match(formatUsageReport(report), /no worker log/);
  assert.equal(summarizeUsage([]).groups.length, 0);
});
test('stable prefix stays identical across features while dynamic assignment remains last', () => {
  const common = { role: 'Fixed role', projectContext: 'Project architecture', baseline: 'abc123' };
  const a = buildWorkerPrompt({ ...common, checkpoint: 'First checkpoint', feature: feature() });
  const b = buildWorkerPrompt({ ...common, checkpoint: 'Other checkpoint',
    feature: { ...feature(), id: 'other', description: 'Different task' } });
  const prefix = stablePromptPrefix(common.role, common.projectContext);
  assert.ok(a.startsWith(prefix));
  assert.ok(b.startsWith(prefix));
  assert.ok(a.indexOf('Current assignment') > a.indexOf('Shared project context'));
  assert.ok(!prefix.includes('First checkpoint'));
  assert.match(a, /Keep the existing collision behavior/);
  assert.ok(boundedText('x'.repeat(200), 80).length <= 80);
});
test('model pins and context budgets are opt-in and validated before a worker starts', () => {
  const root = dir('iwsdk-model-');
  writeFileSync(join(root, 'iwsdk-agent-kit.config.json'), JSON.stringify({
    backend: 'codex', workerModels: { codex: 'gpt-5.3-codex', claude: 'opus', opencode: 'provider/model' },
    promptContextBudget: { projectChars: 4000, handoffChars: 1200 },
  }));
  const settings = readPromptSettings(root);
  assert.equal(settings.workerModels.claude, 'opus');
  assert.equal(settings.promptContextBudget.handoffChars, 1200);
  const f = { worktree: '/tmp/feature', attemptDirectory: '/tmp/log' };
  const codex = workerInvocation('codex', f, '/tmp/git', 'Task', { model: settings.workerModels.codex });
  assert.deepEqual(codex.args.slice(0, 3), ['exec', '-m', 'gpt-5.3-codex']);
  assert.ok(workerInvocation('claude', f, '/tmp/git', 'Task', { model: 'opus' }).args.includes('--model'));
  assert.ok(workerInvocation('opencode', f, '/tmp/git', 'Task', { model: 'provider/model' }).args.includes('--model'));
  assert.throws(() => workerInvocation('muse', f, '/tmp/git', 'Task', { model: 'any' }), /not verified/);
  writeFileSync(join(root, 'iwsdk-agent-kit.config.json'), JSON.stringify({ workerModels: { muse: 'model' } }));
  assert.throws(() => readPromptSettings(root), /not verified/);
  writeFileSync(join(root, 'iwsdk-agent-kit.config.json'), JSON.stringify({ promptContextBudget: { handoffChars: -1 } }));
  assert.throws(() => readPromptSettings(root), /500..16000/);
});
test('compact handoff preserves verified facts without repeating huge agent reports', () => {
  const base = dir('iwsdk-handoff-');
  const state = { id: 'demo', backend: 'codex', baseline: 'abc', directory: base };
  const f = { ...feature(), worktree: join(base, 'missing'), attemptDirectory: join(base, 'attempt') };
  mkdirSync(f.attemptDirectory);
  writeFileSync(join(f.attemptDirectory, 'summary.md'), 'Report ' + 'A'.repeat(40000));
  const rendered = renderCompactHandoff(state, f, { summary: 'A'.repeat(40000), status: ' M src/toys/a.ts', head: 'abcd' });
  assert.ok(rendered.length <= 3500);
  assert.match(rendered, /Confirmed decisions/);
  assert.match(rendered, /quota reached/);
  writeHandoff(state, f);
  assert.ok(existsSync(join(base, 'handoffs', 'toy.md')));
  assert.ok(existsSync(join(base, 'handoffs', 'toy.compact.md')));
  assert.ok(compactHandoffContext(state, f, 800).length <= 800);
});
test('read-only audit identifies possible cache breakers without leaking secrets or changing files', () => {
  const root = dir('iwsdk-audit-'), home = dir('iwsdk-audit-home-');
  mkdirSync(join(root, '.claude', 'skills', 'review'), { recursive: true });
  mkdirSync(join(home, '.claude'), { recursive: true });
  const settings = join(root, '.claude', 'settings.json');
  const contents = JSON.stringify({ permissions: { deny: ['Bash', 'Bash(git push *)'] },
    env: { ANTHROPIC_BASE_URL: 'https://private-secret.example', ENABLE_TOOL_SEARCH: 'false' },
    promptCacheTtl: '1h' }, null, 2);
  writeFileSync(settings, contents);
  writeFileSync(join(root, '.claude', 'skills', 'review', 'SKILL.md'),
    '---\nname: review\nmodel: opus\n---\nReview this diff.');
  writeFileSync(join(home, '.claude', 'settings.json'), '{}');
  const report = auditCacheConfig(root, { home, env: {} });
  assert.ok(report.findings.some(f => f.issue.includes('model without context: fork')));
  assert.ok(report.findings.some(f => f.issue.includes('Whole-tool permission denial')));
  assert.ok(report.findings.some(f => f.issue.includes('endpoint')));
  assert.ok(report.findings.some(f => f.issue.includes('promptCacheTtl')));
  assert.ok(report.findings.some(f => f.issue.includes('Tool search')));
  assert.ok(!JSON.stringify(report).includes('private-secret.example'));
  assert.equal(readFileSync(settings, 'utf8'), contents);
  assert.match(formatCacheAudit(report), /Suggested action/);
});
test('isolated review prompt is read-only and bounded; installer exposes all new commands', () => {
  const state = { id: 'demo', baseline: 'abc', backend: 'codex' };
  const f = { ...feature(), status: 'completed', worktree: '/tmp/feature', startHead: 'abc', head: 'def' };
  const prompt = renderReviewPrompt(state, f, { diffStat: 'src/toys/a.ts | 10 +', checkpoint: 'Inspect behavior' });
  assert.match(prompt, /NEW context/);
  assert.match(prompt, /Do not edit/);
  assert.match(prompt, /src\/toys\/a.ts/);
  assert.throws(() => writeReviewPrompt(state, { ...f, status: 'failed' }), /completed or collected/);
  const root = dir('iwsdk-install-v04-');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'test' }));
  install(root);
  for (const file of ['prompt.mjs', 'usage.mjs', 'review.mjs', 'cache-audit.mjs']) {
    assert.ok(existsSync(join(root, 'scripts', file)));
  }
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['agents:usage'], 'node scripts/agents.mjs usage');
  assert.equal(pkg.scripts['agents:cache-audit'], 'node scripts/cache-audit.mjs');
  assert.equal(pkg.scripts['agents:review-prompt'], 'node scripts/agents.mjs review-prompt');
});

test('installed batch usage, review-prompt and cache-audit commands work without model calls', () => {
  const root = dir('iwsdk-v04-cli-');
  function git(...args) {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  }
  git('init', '-b', 'main');
  git('config', 'user.name', 'CLI Test');
  git('config', 'user.email', 'cli@example.invalid');
  writeFileSync(join(root, 'package.json'), '{"name":"v04-cli-test"}\n');
  writeFileSync(join(root, 'iwsdk-agent-kit.config.json'), '{"backend":"codex","baseBranch":"main"}\n');
  writeFileSync(join(root, 'features.json'), JSON.stringify({
    id: 'usage-demo', features: [{
      id: 'toy', description: 'Test usage', owns: ['src/toys/'], acceptance: ['Tested'],
      interfaces: 'none', contentChanges: false, runtimeRequired: false,
    }],
  }));
  git('add', '.');
  git('commit', '-m', 'baseline');
  const baseline = git('rev-parse', 'HEAD');
  const bin = join(process.cwd(), 'bin', 'iwsdk-agent-kit.mjs');
  function call(...args) {
    const r = spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8', timeout: 15000 });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  }
  call('batch', 'plan', 'features.json');
  const directory = join(root, '.git', 'agent-workflow', 'batches', 'usage-demo');
  const statePath = join(directory, 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const attemptDir = join(directory, 'toy', '1');
  mkdirSync(attemptDir, { recursive: true });
  writeFileSync(join(attemptDir, 'spec.json'), JSON.stringify({ state, feature: state.features[0] }));
  writeFileSync(join(attemptDir, 'worker.jsonl'), jsonl({
    type: 'turn.completed', usage: { input_tokens: 200, cached_input_tokens: 100, output_tokens: 20 },
  }));
  mkdirSync(join(root, 'src', 'toys'), { recursive: true });
  writeFileSync(join(root, 'src', 'toys', 'toy.txt'), 'done\n');
  git('add', '.');
  git('commit', '-m', 'toy implementation');
  state.features[0].status = 'completed';
  state.features[0].attempt = 1;
  state.features[0].attemptDirectory = attemptDir;
  state.features[0].worktree = root;
  state.features[0].startHead = baseline;
  state.features[0].head = git('rev-parse', 'HEAD');
  writeFileSync(statePath, JSON.stringify(state));
  const report = JSON.parse(call('batch', 'usage', 'usage-demo', '--json'));
  assert.equal(report.groups[0].inputTokens, 200);
  assert.equal(report.groups[0].cacheHitRatio, 0.5);
  assert.match(call('batch', 'usage', 'usage-demo'), /Cache read/);
  const promptPath = call('batch', 'review-prompt', 'usage-demo', 'toy');
  assert.ok(existsSync(promptPath));
  assert.match(readFileSync(promptPath, 'utf8'), /NEW context/);
  assert.match(readFileSync(promptPath, 'utf8'), /toy.txt/);
  const audit = JSON.parse(call('cache-audit', '--target', root, '--json'));
  assert.ok(Array.isArray(audit.findings));
});
