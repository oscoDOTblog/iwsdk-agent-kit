import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { detectCoordinator, readProviderPolicy, enforceProviderIsolation } from '../src/provider-policy.mjs';
import { main } from '../src/orchestrator.mjs';
import { install } from '../src/install.mjs';

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}
function createRepo(backend = 'codex') {
  const dir = mkdtempSync(join(tmpdir(), 'iwsdk-provider-'));
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test User');
  git(dir, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'package.json'), '{"name":"test-project"}\n');
  writeFileSync(join(dir, 'iwsdk-agent-kit.config.json'),
    JSON.stringify({ backend, providerIsolation: 'strict', baseBranch: 'main' }));
  writeFileSync(join(dir, 'features.json'), JSON.stringify({
    id: 'provider-test',
    features: [{
      id: 'toy', description: 'Implement a sandbox toy', owns: ['src/toys/'],
      acceptance: ['Toy works'], interfaces: 'none',
      contentChanges: false, runtimeRequired: false,
    }],
  }));
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'initial');
  return dir;
}
function statePath(dir) {
  return join(dir, '.git', 'agent-workflow', 'batches', 'provider-test', 'state.json');
}
function noCoordinatorEnv(fn) {
  const names = ['IWSDK_AGENT_COORDINATOR', 'CODEX_THREAD_ID', 'CLAUDECODE'];
  const previous = names.map(name => process.env[name]);
  names.forEach(name => delete process.env[name]);
  return Promise.resolve().then(fn).finally(() => {
    names.forEach((name, i) => {
      if (previous[i] === undefined) delete process.env[name];
      else process.env[name] = previous[i];
    });
  });
}

test('recognizes known active coordinators and rejects ambiguous signals', () => {
  assert.deepEqual(detectCoordinator({ CODEX_THREAD_ID: 'thread-1' }),
    { backend: 'codex', source: 'CODEX_THREAD_ID' });
  assert.deepEqual(detectCoordinator({ CLAUDECODE: '1' }),
    { backend: 'claude', source: 'CLAUDECODE' });
  assert.deepEqual(detectCoordinator({ IWSDK_AGENT_COORDINATOR: 'muse' }),
    { backend: 'muse', source: 'IWSDK_AGENT_COORDINATOR' });
  assert.deepEqual(detectCoordinator({}), null);
  assert.throws(() => detectCoordinator({ CODEX_THREAD_ID: 'a', CLAUDECODE: '1' }),
    /Conflicting coordinator/);
});

test('default policy locks the project provider and never silently permits a second CLI', () => {
  const policy = { configuredBackend: 'codex', coordinator: null };
  assert.deepEqual(enforceProviderIsolation(policy, ['codex'], [], 'start').requested, ['codex']);
  assert.throws(() => enforceProviderIsolation(policy, ['claude'], [], 'plan'),
    /Provider isolation blocked plan/);
  assert.throws(() => enforceProviderIsolation(policy, ['claude'], ['--approve'], 'start'),
    /Provider isolation blocked start/);
  assert.throws(() => enforceProviderIsolation(policy, ['claude'], ['--allow-cross-provider', 'claude'], 'start'),
    /Provider isolation blocked start/);
  assert.throws(() => enforceProviderIsolation(policy, ['claude'], ['--allow-cross-provider', 'muse', '--approve'], 'start'),
    /Provider isolation blocked start/);
  assert.throws(() => enforceProviderIsolation(policy, ['claude'], ['--allow-cross-provider', '--approve'], 'start'),
    /requires a named backend/);
  assert.deepEqual(enforceProviderIsolation(policy, ['codex', 'claude'],
    ['--allow-cross-provider', 'claude', '--approve'], 'start').explicitCrossProviderApprovals, ['claude']);
  assert.throws(() => enforceProviderIsolation(policy, ['claude', 'muse'],
    ['--allow-cross-provider', 'claude', '--approve'], 'start'), /Provider isolation blocked/);
});

test('detected coordinator must also match; project config alone cannot authorize cross-session use', () => {
  const policy = { configuredBackend: 'claude', coordinator: { backend: 'codex', source: 'CODEX_THREAD_ID' } };
  assert.throws(() => enforceProviderIsolation(policy, ['claude'], [], 'start'), /detected coordinator codex/);
  assert.throws(() => enforceProviderIsolation(policy, ['codex'], [], 'start'), /configured claude/);
  assert.deepEqual(enforceProviderIsolation(policy, ['claude'],
    ['--allow-cross-provider', 'claude', '--approve'], 'start').explicitCrossProviderApprovals, ['claude']);
});

test('existing config without new setting remains strict; disabling policy is rejected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iwsdk-policy-config-'));
  writeFileSync(join(dir, 'iwsdk-agent-kit.config.json'), '{"backend":"codex"}');
  const policy = readProviderPolicy(dir, {});
  assert.equal(policy.mode, 'strict');
  assert.equal(policy.configuredBackend, 'codex');
  writeFileSync(join(dir, 'iwsdk-agent-kit.config.json'), '{"backend":"codex","providerIsolation":false}');
  assert.throws(() => readProviderPolicy(dir, {}), /providerIsolation must be "strict"/);
});

test('planning inherits the configured provider rather than silently defaulting to Codex', () =>
  noCoordinatorEnv(async () => {
    const dir = createRepo('claude');
    await main(['plan', 'features.json'], dir);
    const state = JSON.parse(readFileSync(statePath(dir), 'utf8'));
    assert.equal(state.backend, 'claude');
    assert.equal(state.plannedProviderAuthorization.configuredBackend, 'claude');
  }));

test('explicit batch and per-feature overrides are blocked before state is created', () =>
  noCoordinatorEnv(async () => {
    const dir = createRepo('codex');
    await assert.rejects(main(['plan', 'features.json', '--backend', 'claude'], dir),
      /Provider isolation blocked plan/);
    assert.equal(existsSync(statePath(dir)), false);
    const file = join(dir, 'features.json');
    const batch = JSON.parse(readFileSync(file, 'utf8'));
    batch.features[0].backend = 'claude';
    writeFileSync(file, JSON.stringify(batch));
    await assert.rejects(main(['plan', 'features.json'], dir), /Provider isolation blocked plan/);
    assert.equal(existsSync(statePath(dir)), false);
  }));

test('old Claude batch cannot start after upgrading a Codex-configured project', () =>
  noCoordinatorEnv(async () => {
    const dir = createRepo('codex');
    await main(['plan', 'features.json'], dir);
    const state = JSON.parse(readFileSync(statePath(dir), 'utf8'));
    state.backend = 'claude'; // Simulate a batch created before the isolation upgrade.
    writeFileSync(statePath(dir), JSON.stringify(state));
    await assert.rejects(main(['start', 'provider-test', '--approve'], dir),
      /Provider isolation blocked start/);
    const unchanged = JSON.parse(readFileSync(statePath(dir), 'utf8'));
    assert.equal(unchanged.features[0].status, 'pending');
    assert.equal(unchanged.lastProviderAuthorization, undefined);
    assert.equal(existsSync(unchanged.features[0].worktree), false);
  }));

test('cross-provider authorization at plan does not authorize later start automatically', () =>
  noCoordinatorEnv(async () => {
    const dir = createRepo('codex');
    await main(['plan', 'features.json', '--backend', 'claude',
      '--allow-cross-provider', 'claude', '--approve'], dir);
    const state = JSON.parse(readFileSync(statePath(dir), 'utf8'));
    assert.deepEqual(state.plannedProviderAuthorization.explicitCrossProviderApprovals, ['claude']);
    await assert.rejects(main(['start', 'provider-test', '--approve'], dir),
      /Provider isolation blocked start/);
  }));

test('changing configured provider after plan also blocks an old pending batch', () =>
  noCoordinatorEnv(async () => {
    const dir = createRepo('codex');
    await main(['plan', 'features.json'], dir);
    writeFileSync(join(dir, 'iwsdk-agent-kit.config.json'),
      '{"backend":"claude","providerIsolation":"strict","baseBranch":"main"}');
    await assert.rejects(main(['start', 'provider-test', '--approve'], dir),
      /Provider isolation blocked start/);
  }));

test('installed project runner also blocks an unauthorized Claude subprocess', () =>
  noCoordinatorEnv(async () => {
    const dir = createRepo('codex');
    install(dir);
    const child = spawnSync(process.execPath,
      ['scripts/agents.mjs', 'plan', 'features.json', '--backend', 'claude'],
      { cwd: dir, encoding: 'utf8', env: {
        ...process.env,
        IWSDK_AGENT_COORDINATOR: 'codex',
      } });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /Provider isolation blocked plan/);
    assert.equal(existsSync(statePath(dir)), false);
  }));
