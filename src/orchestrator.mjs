#!/usr/bin/env node
// Small durable worktree scheduler. No model calls are made by planning or tests.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, rmSync, openSync, closeSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { backendName, backendRole, workerInvocation, parseWorkerResult, preflightFor, workerEnvironment } from './backends.mjs';

const self = fileURLToPath(import.meta.url);
const fail = message => { throw new Error(message); };
export function run(command, args, cwd, options = {}) {
  const r = spawnSync(command, args, { cwd, encoding: 'utf8', ...options });
  if (r.error || r.status !== 0) fail(`${command} ${args.join(' ')}: ${r.error?.message ?? r.stderr ?? r.status}`);
  return (r.stdout ?? '').trim();
}
const git = (cwd, ...args) => run('git', args, cwd);
const json = path => JSON.parse(readFileSync(path, 'utf8'));
export function atomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp-${process.pid}`, JSON.stringify(value, null, 2) + '\n');
  renameSync(`${path}.tmp-${process.pid}`, path);
}
export const validId = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(value);
const strings = value => Array.isArray(value) && value.length > 0 && value.every(x => typeof x === 'string' && x.trim());
const overlap = (a, b) => a === b || (a.endsWith('/') && b.startsWith(a)) || (b.endsWith('/') && a.startsWith(b));
const owns = (feature, path) => feature.owns.some(p => p === path || (p.endsWith('/') && path.startsWith(p)));
export function order(features) {
  const sorted = [], visiting = new Set(), done = new Set();
  const visit = f => {
    if (visiting.has(f.id)) fail('Dependency cycle');
    if (done.has(f.id)) return;
    visiting.add(f.id);
    for (const id of f.dependsOn) {
      const dependency = features.find(x => x.id === id);
      if (!dependency || id === f.id) fail(`Invalid dependency ${id}`);
      visit(dependency);
    }
    visiting.delete(f.id); done.add(f.id); sorted.push(f);
  };
  features.forEach(visit); return sorted;
}
export function parseBatch(input) {
  const batch = structuredClone(input);
  if (!validId(batch.id) || !Array.isArray(batch.features) || !batch.features.length) fail('Batch needs id and features');
  batch.backend = backendName(batch.backend);
  batch.maxConcurrency ??= 2;
  if (![1, 2, 3].includes(batch.maxConcurrency)) fail('maxConcurrency must be 1, 2 or 3');
  const ids = new Set();
  for (const f of batch.features) {
    if (!validId(f.id) || f.id === 'integration' || ids.has(f.id)) fail('Invalid or duplicate feature id');
    ids.add(f.id);
    if (typeof f.description !== 'string' || !f.description.trim() || !strings(f.owns) || !strings(f.acceptance)) fail(`${f.id}: description, owns and acceptance required`);
    if (f.owns.some(p => p.startsWith('/') || p.includes('..') || p.includes('\\') || p.includes('*') || p.startsWith('.git'))) fail('Ownership must be relative exact files or directory/ prefixes');
    if (typeof f.interfaces !== 'string' || !f.interfaces.trim()) fail(`${f.id}: coordinator must settle interfaces (or state none)`);
    if (typeof f.contentChanges !== 'boolean' || typeof f.runtimeRequired !== 'boolean') fail(`${f.id}: contentChanges/runtimeRequired must be booleans`);
    f.dependsOn ??= [];
    if (!Array.isArray(f.dependsOn) || !f.dependsOn.every(validId)) fail('dependsOn must list feature ids');
  }
  // Respect declared dependency ordering first, then sequence shared-file owners.
  const sorted = order(batch.features);
  for (let i = 0; i < sorted.length; i++) for (let j = 0; j < i; j++) {
    if (sorted[i].owns.some(a => sorted[j].owns.some(b => overlap(a, b)))) {
      if (!sorted[i].dependsOn.includes(sorted[j].id)) sorted[i].dependsOn.push(sorted[j].id);
    }
  }
  batch.features = order(sorted);
  return batch;
}
export function paths(root, batch, feature) {
  return { branch: `agents/${batch}/${feature}`, worktree: join(root, 'worktrees', batch, feature) };
}
function alive(pid) { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function groupAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(-pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function attemptAlive(f) {
  const claimPath = f.attemptDirectory && join(f.attemptDirectory, 'claim.json');
  const childPath = f.attemptDirectory && join(f.attemptDirectory, 'child.json');
  const claimPid = claimPath && existsSync(claimPath) ? json(claimPath).pid : null;
  const childPid = childPath && existsSync(childPath) ? json(childPath).pid : null;
  // A detached worker's process group outlives its wrapper if npm/Codex is orphaned.
  return alive(f.pid) || groupAlive(f.pid) || alive(claimPid) || groupAlive(claimPid) || alive(childPid);
}
function clean(cwd) { return git(cwd, 'status', '--porcelain', '--untracked-files=all') === ''; }
function context(cwd = process.cwd()) {
  const repo = git(cwd, 'rev-parse', '--show-toplevel');
  const common = resolve(cwd, git(cwd, 'rev-parse', '--git-common-dir'));
  return { repo, common, root: join(common, 'agent-workflow'), worktreeRoot: join(dirname(repo), '.iwsdk-agent-worktrees', createHash('sha256').update(common).digest('hex').slice(0, 12)) };
}
function save(state) { atomic(join(state.directory, 'state.json'), state); }
function load(ctx, id) {
  if (!validId(id)) fail('Supply a valid batch id');
  return json(join(ctx.root, 'batches', id, 'state.json'));
}
function refresh(state) {
  for (const f of state.features) if (f.status === 'running') {
    const receipt = join(f.attemptDirectory, 'receipt.json');
    if (existsSync(receipt)) Object.assign(f, json(receipt));
    else if (!attemptAlive(f)) { f.status = 'interrupted'; f.error = 'Worker exited without receipt; inspect worktree/log before explicit retry'; }
  }
}
async function locked(state, fn) {
  const path = join(state.directory, 'lock.json');
  if (existsSync(path)) {
    const lock = json(path);
    if (alive(lock.pid)) fail(`Batch busy: coordinator PID ${lock.pid}`);
    rmSync(path);
  }
  const fd = openSync(path, 'wx'); writeFileSync(fd, JSON.stringify({ pid: process.pid })); closeSync(fd);
  try { Object.assign(state, json(join(state.directory, 'state.json'))); refresh(state); return await fn(); } finally { save(state); rmSync(path); }
}
function approved(flags) { if (!flags.includes('--approve')) fail('Explicit authorization required: add --approve'); }
export function ready(state) {
  return state.features.filter(f => f.status === 'pending' && f.dependsOn.every(id => ['completed', 'collected'].includes(state.features.find(x => x.id === id).status)));
}
export function workerArgs(f, common) {
  return ['exec', '--strict-config', '--sandbox', 'workspace-write', '-c', 'approval_policy="never"', '-c', 'agents.enabled=false', '--add-dir', common, '--cd', f.worktree, '--json', '--output-last-message', join(f.attemptDirectory, 'summary.md'), '-'];
}
function prompt(state, f) {
  const role = readFileSync(join(state.workflowSource, backendRole(state.backend)), 'utf8');
  return `${role}\nImplement only this approved assignment. Follow root and scoped AGENTS.md and inspect the actual project architecture.\n${JSON.stringify(f, null, 2)}\nBaseline ${state.baseline}; dependency interfaces: ${f.interfaces}.\nOwn only the assigned paths. Do not edit other paths; report needed changes as BLOCKED. Do not change dependencies or save formats unless specifically owned and authorized. No recursive agents or worker processes. Do not launch IWSDK/browser/XR sessions. No push, PR, resets, cleanup, or merge to the base branch. Run only the checks actually available in this project. Commit your changes on the assigned branch. Report exact checks, limitations, runtime acceptance steps, and commit hash. If sandbox/network blocks work, report BLOCKED; never escalate. Leave unfinished work intact.\n`;
}
async function worker(specPath) {
  const { state, feature: f, common } = json(specPath);
  // Exclusive claim closes the spawn/PID-persistence crash window. Retry cancels unclaimed attempts.
  let claim;
  try { claim = openSync(join(f.attemptDirectory, 'claim.json'), 'wx'); } catch { return; }
  writeFileSync(claim, JSON.stringify({ pid: process.pid })); closeSync(claim);
  const log = openSync(join(f.attemptDirectory, 'worker.jsonl'), 'a');
  let result;
  try {
    // Toolchain install is fixed, not model-generated. All model shell commands are sandboxed.
    const installLog = openSync(join(f.attemptDirectory, 'install.log'), 'w');
    const install = spawnSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: f.worktree, stdio: ['ignore', installLog, installLog] }); closeSync(installLog);
    if (install.status !== 0) fail(`npm ci failed (${install.status}); see worker log`);
    const backend = backendName(state.backend);
    const invocation = workerInvocation(backend, f, common, prompt(state, f));
    const code = await new Promise((resolveCode, reject) => {
      const child = spawn(invocation.command, invocation.args, { cwd: f.worktree, stdio: ['pipe', log, log], env: { ...workerEnvironment(backend), AGENT_WORKER_SPEC: specPath } });
      atomic(join(f.attemptDirectory, 'child.json'), { pid: child.pid });
      child.on('error', reject); child.on('close', resolveCode);
      child.stdin.on('error', () => {}); child.stdin.end(invocation.stdin ?? '');
    });
    const summary = join(f.attemptDirectory, 'summary.md');
    if (code !== 0) fail(`${backend} exited ${code}; permission/network errors require coordinator review`);
    if (backend !== 'codex') writeFileSync(summary, parseWorkerResult(backend, readFileSync(join(f.attemptDirectory, 'worker.jsonl'), 'utf8')));
    if (!existsSync(summary) || /\bBLOCKED\b/.test(readFileSync(summary, 'utf8'))) fail('Worker missing summary or reported BLOCKED');
    const head = git(f.worktree, 'rev-parse', 'HEAD');
    if (!clean(f.worktree) || head === f.startHead) fail('Worker must leave clean committed changes');
    result = { status: 'completed', head, endedAt: new Date().toISOString() };
  } catch (e) { result = { status: 'failed', error: e.message, endedAt: new Date().toISOString() }; }
  finally { closeSync(log); }
  atomic(join(f.attemptDirectory, 'receipt.json'), result);
}
function createFeature(state, f) {
  if (existsSync(f.worktree)) {
    if (git(f.worktree, 'branch', '--show-current') !== f.branch || !clean(f.worktree)) fail(`Refuse reuse of dirty/unexpected worktree ${f.worktree}`);
  } else {
    mkdirSync(dirname(f.worktree), { recursive: true });
    git(state.repo, 'worktree', 'add', '-b', f.branch, f.worktree, state.baseline);
  }
  for (const id of f.dependsOn) {
    const dependency = state.features.find(x => x.id === id);
    if (git(state.repo, 'rev-parse', dependency.branch) !== dependency.head) fail(`Prerequisite branch changed: ${id}`);
    git(f.worktree, 'merge', '--no-edit', '--no-ff', dependency.head);
  }
  f.startHead ??= git(f.worktree, 'rev-parse', 'HEAD');
}
async function start(ctx, state) {
  if (process.platform === 'win32') fail('Worker process-group recovery requires POSIX; use Linux, macOS or WSL');
  // Check the chosen CLI before spending model credits; Codex also checks its sandbox.
  try {
    for (const check of preflightFor(state.backend)) run(check.command, check.args, state.workflowSource, { env: workerEnvironment(state.backend) });
    state.preflight = { passed: true, checkedAt: new Date().toISOString() };
  } catch (e) {
    state.preflight = { passed: false, error: e.message, checkedAt: new Date().toISOString() };
    fail(`Worker preflight blocked before inference: ${e.message}`);
  }
  for (;;) {
    refresh(state);
    let running = state.features.filter(f => f.status === 'running').length;
    for (const f of ready(state)) {
      if (running >= state.maxConcurrency) break;
      try {
        createFeature(state, f);
        f.attempt = (f.attempt ?? 0) + 1;
        f.attemptDirectory = join(state.directory, f.id, String(f.attempt));
        mkdirSync(f.attemptDirectory, { recursive: true });
        const specPath = join(f.attemptDirectory, 'spec.json');
        atomic(specPath, { state, feature: f, common: ctx.common });
        // Persist launching intent first. A crash here is interrupted, never automatically duplicated.
        f.status = 'running'; f.pid = process.pid; save(state);
        const child = spawn(process.execPath, [self, '_worker', specPath], { detached: true, stdio: 'ignore' });
        if (!child.pid) fail('Worker spawn failed');
        child.on('error', () => {}); child.unref(); f.pid = child.pid; running++; save(state);
      } catch (e) { f.status = 'blocked'; f.error = e.message; save(state); }
    }
    save(state);
    if (!state.features.some(f => f.status === 'running')) {
      for (const f of state.features) if (f.status === 'pending') { f.status = 'blocked'; f.error = 'Dependency incomplete; retry after prerequisite succeeds'; }
      save(state); break;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(JSON.stringify(state.features.map(({ id, status, error }) => ({ id, status, error })), null, 2));
  if (state.features.some(f => !['completed', 'collected'].includes(f.status))) fail('Batch incomplete; inspect status and logs before retry');
}
function collect(state) {
  state.collection = [];
  for (const f of state.features) {
    if (!['completed', 'collected'].includes(f.status)) fail(`${f.id}: ${f.status}; not collectable`);
    if (!clean(f.worktree) || git(f.worktree, 'rev-parse', 'HEAD') !== f.head) fail(`${f.id}: worktree changed`);
    const files = git(f.worktree, 'diff', '--name-only', f.startHead, f.head).split('\n').filter(Boolean);
    if (!files.length || files.some(p => !owns(f, p))) fail(`${f.id}: empty change or ownership violation: ${files.join(', ')}`);
    state.collection.push({ id: f.id, head: f.head, files, commits: git(f.worktree, 'log', '--oneline', `${f.startHead}..${f.head}`), summary: readFileSync(join(f.attemptDirectory, 'summary.md'), 'utf8') });
    f.status = 'collected';
  }
  atomic(join(state.directory, 'collection.json'), state.collection);
  const reviewPath = join(state.directory, 'review.json');
  if (!existsSync(reviewPath)) atomic(reviewPath, { approved: false, heads: Object.fromEntries(state.features.map(f => [f.id, f.head])), architecture: '', tests: '', runtime: 'not tested', physicalQuest: 'not tested' });
  console.log(`Review collection.json and diffs, then fill ${reviewPath}. Evidence is required; do not simply toggle approval.`);
}
function review(state) {
  const r = json(join(state.directory, 'review.json'));
  if (!r.approved || !r.architecture?.trim() || !r.tests?.trim()) fail('Coordinator architecture/test review required');
  for (const f of state.features) {
    if (f.status !== 'collected' || r.heads[f.id] !== f.head || git(state.repo, 'rev-parse', f.branch) !== f.head) fail('Review stale or feature not collected');
  }
  return r;
}
function integration(state) {
  review(state);
  const p = paths(state.worktreeRoot, state.id, 'integration');
  state.integration ??= { ...p, status: 'pending' };
  const i = state.integration;
  if (!existsSync(i.worktree)) {
    mkdirSync(dirname(i.worktree), { recursive: true });
    git(state.repo, 'worktree', 'add', '-b', i.branch, i.worktree, state.baseline);
  }
  if (git(i.worktree, 'branch', '--show-current') !== i.branch) fail('Integration worktree is on an unexpected branch');
  if (!clean(i.worktree) || existsSync(git(i.worktree, 'rev-parse', '--git-path', 'MERGE_HEAD'))) fail(`Resolve and commit integration conflicts first: ${i.worktree}`);
  i.status = 'integrating'; save(state);
  for (const f of state.features) {
    try { git(i.worktree, 'merge', '--no-ff', '--no-edit', f.head); }
    catch (e) { i.status = 'conflict'; i.error = e.message; fail(`Conflict preserved in ${i.worktree}; resolve deliberately, commit, rerun integrate`); }
  }
  i.status = 'validating'; i.checks = []; save(state);
  const scripts = json(join(i.worktree, 'package.json')).scripts ?? {};
  const commands = [];
  if (existsSync(join(i.worktree, 'package-lock.json'))) commands.push(['ci']);
  for (const name of ['typecheck', 'test', 'generator:report', 'build']) if (scripts[name]) commands.push(name === 'test' ? ['test'] : ['run', name]);
  if (!commands.length) fail('No project validation commands available; configure checks before integration');
  for (const args of commands) {
    const logPath = join(state.directory, `integration-${args.join('-').replaceAll(':', '-')}.log`);
    const fd = openSync(logPath, 'w');
    const result = spawnSync('npm', args, { cwd: i.worktree, stdio: ['ignore', fd, fd] }); closeSync(fd);
    i.checks.push({ command: `npm ${args.join(' ')}`, passed: result.status === 0, logPath }); save(state);
    if (result.status !== 0) { i.status = 'failed'; fail(`Validation failed; see ${logPath}`); }
  }
  i.head = git(i.worktree, 'rev-parse', 'HEAD');
  i.status = state.features.some(f => f.runtimeRequired) ? 'runtime-pending' : 'ready';
  console.log(`Integration ${i.status}: ${i.worktree}. For interactive work record runtime evidence bound to ${i.head} in review.json (integrationHead, runtimePassed, runtime).`);
}
function publish(state) {
  const r = review(state), i = state.integration;
  if (!i || git(i.worktree, 'branch', '--show-current') !== i.branch || !['ready', 'runtime-pending'].includes(i.status) || !clean(i.worktree) || git(i.worktree, 'rev-parse', 'HEAD') !== i.head || !i.checks?.every(c => c.passed)) fail('Passing unchanged integration required');
  if (state.features.some(f => f.runtimeRequired) && (!r.runtimePassed || r.integrationHead !== i.head || !r.runtime?.trim() || r.runtime === 'not tested')) fail('Combined emulated interaction evidence required (physical Quest remains separate)');
  const body = join(state.directory, 'pr.md');
  writeFileSync(body, `Batch ${state.id}\n\n${state.features.map(f => `- ${f.description}`).join('\n')}\n\nValidation\n${i.checks.map(c => `- ${c.command}: passed`).join('\n')}\n\nRuntime: ${r.runtime}\nPhysical Quest: ${r.physicalQuest ?? 'not tested'}\n\nArchitecture review: ${r.architecture}\n`);
  git(i.worktree, 'push', '-u', 'origin', i.branch);
  const existing = run('gh', ['pr', 'list', '--head', i.branch, '--base', state.baseBranch, '--json', 'url'], i.worktree);
  state.pr = JSON.parse(existing)[0]?.url ?? run('gh', ['pr', 'create', '--base', state.baseBranch, '--head', i.branch, '--title', `Feature batch: ${state.id}`, '--body-file', body], i.worktree);
  console.log(state.pr);
}
function cleanup(state) {
  const i = state.integration;
  if (!i || !['ready', 'runtime-pending'].includes(i.status)) fail('Unfinished batch: cleanup refused');
  // Keep integration checkout and all branches. Only remove collected, integrated feature checkouts.
  for (const f of state.features) {
    if (f.status !== 'collected' || !existsSync(f.worktree)) continue;
    if (git(f.worktree, 'branch', '--show-current') !== f.branch || git(f.worktree, 'rev-parse', 'HEAD') !== f.head) fail(`Changed worktree preserved: ${f.worktree}`);
    if (!clean(f.worktree)) fail(`Dirty worktree preserved: ${f.worktree}`);
    const ignored = git(f.worktree, 'ls-files', '--others', '--ignored', '--exclude-standard').split('\n').filter(p => p && !p.startsWith('node_modules/') && !p.startsWith('dist/'));
    if (ignored.length) fail(`Ignored personal/runtime files preserved: ${f.worktree}: ${ignored.slice(0, 5).join(', ')}`);
    git(i.worktree, 'merge-base', '--is-ancestor', f.head, 'HEAD');
    git(state.repo, 'worktree', 'remove', f.worktree);
    f.cleaned = true; save(state);
  }
  console.log('Completed feature worktrees removed; branches, logs and integration worktree preserved.');
}
export async function main(args = process.argv.slice(2), cwd = process.cwd()) {
  const [command, id, ...flags] = args;
  if (command === '_worker') return worker(id);
  const ctx = context(cwd);
  if (command === 'plan') {
    const requested = json(resolve(cwd, id));
    const batch = parseBatch(requested);
    const selected = flags.indexOf('--backend');
    if (selected >= 0) {
      const cliBackend = backendName(flags[selected + 1]);
      if (requested.backend !== undefined && requested.backend !== cliBackend) fail('Batch backend conflicts with --backend');
      batch.backend = cliBackend;
    }
    const directory = join(ctx.root, 'batches', batch.id);
    mkdirSync(join(ctx.root, 'batches'), { recursive: true });
    try { mkdirSync(directory); } catch (error) { if (error.code === 'EEXIST') fail('Batch already exists; choose a new id'); throw error; }
    const config = existsSync(join(ctx.repo, 'iwsdk-agent-kit.config.json')) ? json(join(ctx.repo, 'iwsdk-agent-kit.config.json')) : {};
    const baseBranch = requested.baseBranch ?? config.baseBranch ?? 'main';
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(baseBranch) || baseBranch.includes('..')) fail('Invalid base branch');
    const baseline = git(ctx.repo, 'rev-parse', '--verify', `refs/heads/${baseBranch}^{commit}`);
    // Use the committed baseline without modifying the original checkout.
    const state = { ...batch, baseBranch, version: 1, baseline, repo: ctx.repo, root: ctx.root, directory, workflowSource: ctx.repo, worktreeRoot: ctx.worktreeRoot, createdAt: new Date().toISOString() };
    state.features = batch.features.map(f => ({ ...f, ...paths(ctx.worktreeRoot, batch.id, f.id), status: 'pending' }));
    save(state); console.log(JSON.stringify(state, null, 2)); return;
  }
  const state = load(ctx, id);
  state.backend = backendName(state.backend); // Pre-migration batches remain Codex-backed.
  if (command === 'status') { refresh(state); console.log(JSON.stringify(state, null, 2)); return; }
  await locked(state, async () => {
    switch (command) {
      case 'start': approved(flags); await start(ctx, state); break;
      case 'collect': collect(state); break;
      case 'integrate': approved(flags); integration(state); break;
      case 'publish': approved(flags); publish(state); break;
      case 'cleanup': approved(flags); cleanup(state); break;
      case 'retry': {
        approved(flags); const f = state.features.find(x => x.id === flags[0]);
        if (!f || !['failed', 'blocked', 'interrupted'].includes(f.status) || attemptAlive(f)) fail('Only stopped failed/blocked/interrupted workers may be retried');
        if (f.attemptDirectory && existsSync(join(f.attemptDirectory, 'claim.json')) && alive(json(join(f.attemptDirectory, 'claim.json')).pid)) fail('Worker claim still alive');
        if (f.attemptDirectory && !existsSync(join(f.attemptDirectory, 'claim.json'))) {
          const fd = openSync(join(f.attemptDirectory, 'claim.json'), 'wx'); writeFileSync(fd, JSON.stringify({ canceled: true })); closeSync(fd);
        }
        if (f.attemptDirectory && existsSync(join(f.attemptDirectory, 'child.json')) && alive(json(join(f.attemptDirectory, 'child.json')).pid)) fail('Worker child still running');
        if (existsSync(f.worktree) && !clean(f.worktree)) fail('Inspect and commit unfinished work before retry');
        f.status = 'pending'; delete f.error; break;
      }
      default: fail('Commands: plan FILE | start/status/collect/integrate/publish/cleanup ID | retry ID FEATURE --approve');
    }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === self) main().catch(e => { console.error(e.message); process.exitCode = 1; });
