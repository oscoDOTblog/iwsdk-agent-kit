import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateDocsRequests, validateContextConfig } from '../src/context-config.mjs';
import { validateConductorConfig } from '../src/conductor-config.mjs';
import { buildDependencyGraph, impactForPaths, dependencyImpact, changedPathsFromDiff } from '../src/dependency-map.mjs';
import { installedVersion, queryContext7, normalizeContext7 } from '../src/context7-docs.mjs';
import { prepareFeatureContext, featureContext, checkerDependencyContext } from '../src/context-enrichment.mjs';
import { parseBatch } from '../src/orchestrator.mjs';
import { workerEnvironment } from '../src/backends.mjs';

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'iwsdk-context-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Context Tests');
  git(repo, 'config', 'user.email', 'context@example.invalid');
  mkdirSync(join(repo, 'src'));
  mkdirSync(join(repo, 'tests'));
  writeFileSync(join(repo, 'src', 'core.ts'), 'export const value = 42;\n');
  writeFileSync(join(repo, 'src', 'bridge.ts'), "import { value } from './core';\nexport { value };\n");
  writeFileSync(join(repo, 'src', 'entry.ts'), "export { value } from './bridge';\n");
  writeFileSync(join(repo, 'tests', 'core.test.mjs'), "import '../src/core.ts';\n");
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ type: 'module',
    dependencies: { three: '^0.180.0', 'other-lib': '2.3.4' } }));
  writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({
    lockfileVersion: 3, packages: { 'node_modules/three': { version: '0.180.0' } },
  }));
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'baseline');
  const directory = join(repo, '.git', 'agent-workflow', 'batches', 'context');
  mkdirSync(directory, { recursive: true });
  const feature = { id: 'core-fix', owns: ['src/core.ts'], description: 'Fix interaction input',
    acceptance: ['Callers still compile'], interfaces: 'No API changes',
    docsRequests: [{ libraryId: '/mrdoob/three.js', package: 'three',
      query: 'How to use Raycaster for object interaction?' }] };
  const state = { repo, directory, baseline: git(repo, 'rev-parse', 'HEAD'), conductor: {
    enabled: true, contextEnabled: true,
  } };
  return { repo, directory, feature, state };
}
const config = (overrides = {}) => validateConductorConfig({
  enabled: true, aiPlanning: false, aiVerification: false,
  specialists: { enabled: true, context: { enabled: true, dependencyMap: true,
    documentation: { enabled: true, maxRequests: 2, ...overrides } } },
});
const response = (body, status = 200) => ({
  status, headers: { get: () => null }, text: async () => JSON.stringify(body),
});
const docs = () => ({
  codeSnippets: [{ rank: 2, codeTitle: 'Raycaster', codeId: 'https://threejs.org/docs/#api/en/core/Raycaster',
    codeList: [{ code: 'const raycaster = new Raycaster();' }] }],
  infoSnippets: [{ rank: 1, breadcrumb: 'Raycasting', pageId: 'https://threejs.org/docs/',
    content: 'Use a ray to intersect scene objects.' }],
  version: { requested: 'v0.180.0', served: 'v0.179.0', status: 'unverified' },
});

test('context remains opt-in and does not change v0.6 or manual defaults', () => {
  const legacy = validateConductorConfig({ enabled: true, specialists: { enabled: true } });
  assert.equal(legacy.specialists.context.enabled, false);
  assert.equal(legacy.specialists.context.documentation.enabled, false);
  assert.equal(validateConductorConfig({}).specialists.context.enabled, false);
  assert.throws(() => validateConductorConfig({ specialists: { enabled: true,
    context: { enabled: true } } }), /requires enabled conductor/);
  assert.throws(() => validateConductorConfig({ enabled: true, specialists: {
    enabled: false, context: { enabled: true } } }), /requires enabled conductor/);
  assert.throws(() => validateContextConfig({ enabled: true, documentation: { provider: 'evil' } }), /Context7/);
  assert.throws(() => validateContextConfig({ enabled: true, documentation: { maxRequests: 1000 } }), /maxRequests/);
  assert.throws(() => validateContextConfig({ unknown: true }), /known keys/);
});

test('documentation requests must be explicit, bounded, and cannot specify arbitrary URLs or commands', () => {
  const good = { libraryId: '/mrdoob/three.js', package: 'three', query: 'How to raycast in WebXR?' };
  assert.equal(validateDocsRequests([good]).length, 1);
  for (const bad of [
    { ...good, libraryId: 'https://internal.example/secrets' },
    { ...good, package: '../../private' },
    { ...good, query: '' },
    { ...good, version: 'latest' },
    { ...good, url: 'https://example.com' },
  ]) assert.throws(() => validateDocsRequests([bad]), /docsRequests/);
  assert.throws(() => validateDocsRequests([good, good]), /duplicate/);
});

test('offline graph finds transitive callers, ignores untracked files and reports limitations', () => {
  const { repo } = fixture();
  writeFileSync(join(repo, 'src', 'untracked.ts'), "import './core';\n");
  const graph = buildDependencyGraph(repo);
  assert.ok(graph.inspected >= 3);
  const impact = impactForPaths(graph, ['src/core.ts']);
  assert.deepEqual(impact.seeds, ['src/core.ts']);
  assert.ok(impact.callers.some(c => c.path === 'src/bridge.ts' && c.line === 1 && c.depth === 1));
  assert.ok(impact.callers.some(c => c.path === 'src/entry.ts' && c.depth === 2));
  assert.ok(!impact.callers.some(c => c.path === 'src/untracked.ts'));
  assert.match(impact.limitations, /aliases/);
  assert.equal(dependencyImpact(repo, ['src/']).seeds.length >= 3, true);
  assert.deepEqual(changedPathsFromDiff('diff --git a/src/core.ts b/src/core.ts\n'), ['src/core.ts']);
});

test('exact installed versions are resolved from lockfile, not loose ranges', () => {
  const { repo } = fixture();
  assert.equal(installedVersion(repo, 'three'), '0.180.0');
  assert.equal(installedVersion(repo, 'other-lib'), '2.3.4');
  assert.equal(installedVersion(repo, 'unknown-lib'), null);
});

test('Context7 lookup sends only approved library/version/query, never repository content', async () => {
  const { repo, feature } = fixture();
  let calls = 0;
  const result = await queryContext7(repo, feature.docsRequests[0], {
    maxChars: 3000, timeoutMs: 2000,
  }, {
    env: { CONTEXT7_API_KEY: 'fake-key' },
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(new URL(url).origin, 'https://context7.com');
      assert.equal(new URL(url).searchParams.get('libraryId'), '/mrdoob/three.js@v0.180.0');
      assert.equal(new URL(url).searchParams.get('query'), feature.docsRequests[0].query);
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Bearer fake-key');
      assert.ok(!url.includes('export%20const'));
      return response(docs());
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 'available');
  assert.equal(result.versionStatus, 'unverified');
  assert.equal(result.installedVersion, '0.180.0');
  assert.equal(result.snippets[0].rank, 1);
  assert.equal(result.snippets[0].source, 'https://threejs.org/docs/');
  assert.ok(!JSON.stringify(result).includes('fake-key'));
});

test('missing key, unknown version, mismatched version and rate limits never trigger fallback', async () => {
  const { repo, feature } = fixture();
  let calls = 0;
  const fetchImpl = async () => { calls++; return response({ error: 'rate_limit_exceeded' }, 429); };
  const options = { maxChars: 3000, timeoutMs: 2000 };
  const request = feature.docsRequests[0];
  assert.equal((await queryContext7(repo, request, options, { env: {}, fetchImpl })).reason, 'missing-CONTEXT7_API_KEY');
  assert.equal((await queryContext7(repo, { ...request, package: 'missing' }, options,
    { env: { CONTEXT7_API_KEY: 'fake' }, fetchImpl })).reason, 'no-exact-installed-version');
  assert.equal((await queryContext7(repo, { ...request, version: '0.150.0' }, options,
    { env: { CONTEXT7_API_KEY: 'fake' }, fetchImpl })).reason, 'installed-version-mismatch');
  assert.equal(calls, 0);
  assert.equal((await queryContext7(repo, request, options,
    { env: { CONTEXT7_API_KEY: 'fake' }, fetchImpl })).reason, 'http-429');
  assert.equal(calls, 1);
});

test('documentation source URLs and snippets are sanitized and size-bounded', () => {
  const { repo, feature } = fixture();
  const raw = docs();
  raw.infoSnippets[0].pageId = 'javascript:alert(1)';
  raw.infoSnippets[0].content = 'A'.repeat(20000);
  const result = normalizeContext7(raw, feature.docsRequests[0], installedVersion(repo, 'three'), 500);
  assert.equal(result.snippets[0].source, null);
  assert.ok(result.snippets.reduce((n, s) => n + s.excerpt.length, 0) <= 500);
  assert.throws(() => normalizeContext7({ bogus: true }, feature.docsRequests[0], null, 500), /unexpected/);
});

test('context enrichment caches reports, counts calls before network, and feeds concise fixer handoff', async () => {
  const { state, feature, directory } = fixture();
  const cfg = config();
  const conductor = {};
  let persists = 0, calls = 0;
  const persist = () => { persists++; };
  const fetchImpl = async () => { calls++; return response(docs()); };
  const first = await prepareFeatureContext(state, feature, cfg, conductor, persist,
    { fetchImpl, env: { CONTEXT7_API_KEY: 'fake' } });
  assert.equal(first.docs[0].status, 'available');
  assert.ok(first.map.callers.some(c => c.path === 'src/bridge.ts'));
  assert.equal(calls, 1);
  assert.ok(persists >= 2);
  assert.equal(conductor.contextLookups.length, 1);
  const again = await prepareFeatureContext(state, feature, cfg, conductor, persist,
    { fetchImpl, env: { CONTEXT7_API_KEY: 'fake' } });
  assert.deepEqual(again, first);
  assert.equal(calls, 1);
  assert.match(featureContext(state, feature), /three\.js/);
  assert.ok(existsSync(join(directory, 'conductor', 'context', 'core-fix.json')));
  state.conductor = undefined;
  assert.equal(featureContext(state, feature), '');
});

test('lookup budgets and interrupted calls cannot silently retry external requests', async () => {
  const { state, feature } = fixture();
  const cfg = config({ maxRequests: 1 });
  const conductor = {};
  const fetchImpl = async () => response(docs());
  const second = { libraryId: '/other/repo', package: 'other-lib', query: 'How to use the public API?' };
  feature.docsRequests.push(second);
  const result = await prepareFeatureContext(state, feature, cfg, conductor, () => {},
    { fetchImpl, env: { CONTEXT7_API_KEY: 'fake' } });
  assert.equal(result.docs[0].status, 'available');
  assert.equal(result.docs[1].reason, 'lookup-budget-exhausted');
  assert.equal(conductor.contextLookups.length, 1);
  // Simulate a crash after the reservation was durably written, before the fetch.
  const fresh = fixture();
  const interrupted = {};
  await assert.rejects(prepareFeatureContext(fresh.state, fresh.feature, config(), interrupted,
    () => { throw new Error('simulated crash after reservation'); },
    { fetchImpl, env: { CONTEXT7_API_KEY: 'fake' } }), /simulated crash/);
  assert.equal(interrupted.contextLookups[0].status, 'started');
  const resumed = await prepareFeatureContext(fresh.state, fresh.feature, config(), interrupted,
    () => {}, { fetchImpl: () => { throw new Error('Must not retry'); },
      env: { CONTEXT7_API_KEY: 'fake' } });
  assert.equal(resumed.docs[0].reason, 'interrupted-lookup');
});

test('checker receives independent post-commit caller map, not another paid documentation call', () => {
  const { state, feature, repo } = fixture();
  feature.worktree = repo;
  const cfg = config();
  const context = checkerDependencyContext(state, feature, {
    patch: 'diff --git a/src/core.ts b/src/core.ts\n',
  }, cfg);
  assert.match(context, /src\/bridge\.ts/);
  assert.match(context, /advisory/);
  const disabled = validateConductorConfig({ enabled: true, specialists: { enabled: true } });
  assert.equal(checkerDependencyContext(state, feature, { patch: '' }, disabled), '');
});

test('manual planning validates documentation specs but never invokes context or external services', () => {
  const { repo, directory } = fixture();
  const batch = { id: 'manual', backend: 'codex', features: [{
    id: 'f', description: 'Change a feature', owns: ['src/core.ts'], acceptance: ['works'],
    interfaces: 'none', contentChanges: false, runtimeRequired: false,
    docsRequests: [{ libraryId: '/mrdoob/three.js', package: 'three',
      query: 'How to use Raycaster for objects?' }],
  }] };
  assert.equal(parseBatch(batch).features[0].docsRequests.length, 1);
  assert.equal(existsSync(join(directory, 'conductor', 'context')), false);
  assert.throws(() => parseBatch({ ...batch, features: [{
    ...batch.features[0], docsRequests: [{ libraryId: 'http://internal', package: 'three', query: 'What is this?' }],
  }] }), /docsRequests/);
});

test('Context7 API key never propagates to any model subprocess', () => {
  const env = { CONTEXT7_API_KEY: 'secret', HOME: '/tmp/home', CLAUDECODE: '1' };
  for (const provider of ['claude', 'codex', 'opencode', 'muse']) {
    const child = workerEnvironment(provider, env);
    assert.equal(child.CONTEXT7_API_KEY, undefined);
    assert.equal(child.HOME, '/tmp/home');
  }
  assert.equal(env.CONTEXT7_API_KEY, 'secret'); // Parent keeps it for the explicit HTTP lookup.
});
