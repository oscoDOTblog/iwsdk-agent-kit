#!/usr/bin/env node
// Small durable worktree scheduler. No model calls are made by planning or tests.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, rmSync, openSync, closeSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { backendName, backendRole, workerInvocation, parseWorkerResult, preflightFor, workerEnvironment } from './backends.mjs';
import { sharedContext, compactHandoffContext, writeHandoff, classifyFailure } from './handoff.mjs';
import { buildWorkerPrompt, readPromptSettings } from './prompt.mjs';
import { readBatchUsage, formatUsageReport } from './usage.mjs';
import { writeReviewPrompt } from './review.mjs';
import { readProviderPolicy, enforceProviderIsolation } from './provider-policy.mjs';
import { recordEvidence, inspectEvidence } from './evidence.mjs';
import { investigationContext, validateTargetedTests } from './specialists.mjs';
import { validateDocsRequests } from './context-config.mjs';
import { featureContext } from './context-enrichment.mjs';
import { repairContext } from './convergence.mjs';

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
    if (f.backend !== undefined) f.backend = backendName(f.backend);
    if (f.targetedTests !== undefined) validateTargetedTests(f.targetedTests);
    if (f.regressionTests !== undefined) {
      const regression = validateTargetedTests(f.regressionTests);
      if (regression.length > 4 || regression.some(p => !(f.targetedTests ?? []).includes(p))) {
        fail(f.id + ': regressionTests must contain at most four paths already listed in targetedTests');
      }
    }
    if (f.docsRequests !== undefined) validateDocsRequests(f.docsRequests);
    if (f.decisions !== undefined && (!Array.isArray(f.decisions) || !f.decisions.every(v => typeof v === 'string' && v.trim()))) {
      fail(f.id + ': decisions must be a list of confirmed non-empty strings');
    }
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
    if (existsSync(receipt)) { Object.assign(f, json(receipt)); writeHandoff(state, f); }
    else if (!attemptAlive(f)) {
      f.status = 'interrupted'; f.error = 'Worker exited without receipt; inspect worktree/log before explicit retry';
      writeHandoff(state, f);
    }
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
  const candidates = state.features.filter(f => f.status === 'pending' &&
    f.dependsOn.every(id => ['completed', 'collected'].includes(state.features.find(x => x.id === id).status)));
  if (state.conductor?.enabled && Array.isArray(state.conductor.priority)) {
    const rank = new Map(state.conductor.priority.map((id, index) => [id, index]));
    candidates.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
  }
  return candidates;
}
export function workerArgs(f, common) {
  return ['exec', '--strict-config', '--sandbox', 'workspace-write', '-c', 'approval_policy="never"', '-c', 'agents.enabled=false', '--add-dir', common, '--cd', f.worktree, '--json', '--output-last-message', join(f.attemptDirectory, 'summary.md'), '-'];
}
function prompt(state, f) {
  const backend = backendName(f.backend ?? state.backend);
  const role = readFileSync(join(state.workflowSource, backendRole(backend)), 'utf8');
  const settings = state.promptSettings ?? readPromptSettings(state.repo);
  const budget = settings.promptContextBudget;
  return buildWorkerPrompt({
    role,
    projectContext: sharedContext(state, budget.projectChars),
    checkpoint: compactHandoffContext(state, f, budget.handoffChars) + investigationContext(state, f) + featureContext(state, f) + repairContext(state, f),
    feature: f,
    baseline: state.baseline,
  });
}
export function resolveWorkerModel(state, backend) {
  return (state.conductor?.fixerProvider === backend ? state.conductor?.fixerModel : null) ??
    (state.promptSettings ?? readPromptSettings(state.repo)).workerModels[backend] ?? null;
}
async function worker(specPath) {
  const { state, feature: f, common, providerAuthorization } = json(specPath);
  const workerBackend = backendName(f.backend ?? state.backend);
  if (!providerAuthorization?.requested?.includes(workerBackend)) {
    fail('Missing provider authorization from coordinator start; refusing to launch a model worker');
  }
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
    const backend = backendName(f.backend ?? state.backend);
    const model = resolveWorkerModel(state, backend);
    const invocation = workerInvocation(backend, f, common, prompt(state, f), { model });
    const code = await new Promise((resolveCode, reject) => {
      const child = spawn(invocation.command, invocation.args, { cwd: f.worktree, stdio: ['pipe', log, log], env: { ...workerEnvironment(backend), AGENT_WORKER_SPEC: specPath } });
      atomic(join(f.attemptDirectory, 'child.json'), { pid: child.pid });
      child.on('error', reject); child.on('close', resolveCode);
      child.stdin.on('error', () => {}); child.stdin.end(invocation.stdin ?? '');
    });
    const summary = join(f.attemptDirectory, 'summary.md');
    if (code !== 0) {
      const hint = classifyFailure(readFileSync(join(f.attemptDirectory, 'worker.jsonl'), 'utf8'));
      fail(`${backend} exited ${code} (${hint}); inspect worker log and preserve partial work`);
    }
    if (backend !== 'codex') writeFileSync(summary, parseWorkerResult(backend, readFileSync(join(f.attemptDirectory, 'worker.jsonl'), 'utf8')));
    if (!existsSync(summary) || /\bBLOCKED\b/.test(readFileSync(summary, 'utf8'))) fail('Worker missing summary or reported BLOCKED');
    const head = git(f.worktree, 'rev-parse', 'HEAD');
    if (!clean(f.worktree) || head === (f.repairBaseHead ?? f.startHead)) fail('Worker must leave clean NEW committed changes');
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
async function start(ctx, state, flags, options = {}) {
  // Recheck on EVERY start, even for batches planned before provider isolation existed.
  // This must run before preflight, npm ci, worktree creation, or any model CLI.
  const policy = readProviderPolicy(ctx.repo);
  const activeBackends = state.features.filter(f => ['pending', 'running'].includes(f.status))
    .map(f => backendName(f.backend ?? state.backend));
  const providerAuthorization = enforceProviderIsolation(policy, activeBackends, flags, 'start');
  state.lastProviderAuthorization = { ...providerAuthorization, at: new Date().toISOString() };
  if (process.platform === 'win32') fail('Worker process-group recovery requires POSIX; use Linux, macOS or WSL');
  // Check the chosen CLI before spending model credits; Codex also checks its sandbox.
  try {
    const backends = [...new Set(state.features.filter(f => f.status === 'pending').map(f => backendName(f.backend ?? state.backend)))];
    for (const backend of backends) for (const check of preflightFor(backend)) {
      run(check.command, check.args, state.workflowSource, { env: workerEnvironment(backend) });
    }
    state.preflight = { passed: true, checkedAt: new Date().toISOString() };
  } catch (e) {
    state.preflight = { passed: false, error: e.message, checkedAt: new Date().toISOString() };
    fail(`Worker preflight blocked before inference: ${e.message}`);
  }
  let lastCheckpoint = 0;
  const limits = options.conductor ?? null;
  let launched = 0;
  for (;;) {
    if (limits && Date.now() >= limits.deadlineAt) break;
    refresh(state);
    if (Date.now() - lastCheckpoint >= 60000) {
      for (const f of state.features.filter(f => f.status === 'running')) writeHandoff(state, f);
      lastCheckpoint = Date.now();
    }
    let running = state.features.filter(f => f.status === 'running').length;
    for (const f of ready(state)) {
      if (limits && (launched >= limits.maxStarts || Date.now() >= limits.deadlineAt)) break;
      if (running >= (limits?.maxConcurrency ?? state.maxConcurrency)) break;
      try {
        createFeature(state, f);
        f.attempt = (f.attempt ?? 0) + 1;
        f.attemptDirectory = join(state.directory, f.id, String(f.attempt));
        mkdirSync(f.attemptDirectory, { recursive: true });
        const specPath = join(f.attemptDirectory, 'spec.json');
        atomic(specPath, { state, feature: f, common: ctx.common, providerAuthorization });
        // Persist launching intent first. A crash here is interrupted, never automatically duplicated.
        f.status = 'running'; f.pid = process.pid; save(state);
        const child = spawn(process.execPath, [self, '_worker', specPath], { detached: true, stdio: 'ignore' });
        if (!child.pid) fail('Worker spawn failed');
        child.on('error', () => {}); child.unref(); f.pid = child.pid; running++; launched++; save(state);
      } catch (e) { f.status = 'blocked'; f.error = e.message; save(state); }
    }
    save(state);
    if (!state.features.some(f => f.status === 'running')) {
      if (!limits) {
        for (const f of state.features) if (f.status === 'pending') {
          f.status = 'blocked'; f.error = 'Dependency incomplete; retry after prerequisite succeeds';
        }
      }
      save(state); break;
    }
    // A scheduling limit pauses the coordinator; already launched detached workers
    // are never killed or duplicated. The next invocation reconciles receipts.
    if (limits && (launched >= limits.maxStarts || Date.now() >= limits.deadlineAt)) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(JSON.stringify(state.features.map(({ id, status, error }) => ({ id, status, error })), null, 2));
  if (!limits && state.features.some(f => !['completed', 'collected'].includes(f.status))) {
    fail('Batch incomplete; inspect status and logs before retry');
  }
}
function repair(ctx, state, flags) {
  approved(flags);
  const feature = state.features.find(f => f.id === flags[0]);
  if (!feature || feature.status !== 'completed' || !feature.head || !state.conductor?.convergenceEnabled) {
    fail('Repair requires a completed feature in an explicitly opted-in convergence batch');
  }
  const conductorFile = join(state.directory, 'conductor.json');
  if (!existsSync(conductorFile)) fail('Conductor snapshot required before repair');
  const snapshot = json(conductorFile);
  const cfg = snapshot.config;
  if (!cfg?.convergence?.enabled || (feature.repairCount ?? 0) >= cfg.convergence.maxRepairsPerFeature) {
    fail('Repair is disabled or its per-feature budget is exhausted');
  }
  if (state.features.reduce((n, f) => n + (f.attempt ?? 0), 0) >= cfg.maxWorkerStarts) {
    fail('Total worker start budget exhausted');
  }
  if (state.features.some(f => f.dependsOn.includes(feature.id) && f.status !== 'pending')) {
    fail('Dependent feature already started; repair requires manual coordination');
  }
  if (state.integration || state.collection || existsSync(join(state.directory, 'review.json'))) {
    fail('Cannot repair after collection/review/integration has begun');
  }
  if (!existsSync(feature.worktree) || !clean(feature.worktree) ||
      git(feature.worktree, 'branch', '--show-current') !== feature.branch ||
      git(feature.worktree, 'rev-parse', 'HEAD') !== feature.head) {
    fail('Repair requires the unchanged clean feature branch at its recorded commit');
  }
  const files = git(feature.worktree, 'diff', '--name-only', feature.startHead, feature.head).split('\n').filter(Boolean);
  if (!files.length || files.some(path => !owns(feature, path))) fail('Repair blocked by ownership violation or empty patch');
  const feedbackFile = join(state.directory, 'conductor', 'feedback', feature.id + '.json');
  if (!existsSync(feedbackFile)) fail('Deterministic feedback required for repair');
  const feedback = json(feedbackFile);
  if (feedback.head !== feature.head || feedback.feature !== feature.id ||
      feedback.status !== 'failed' || feedback.repeated || feedback.infrastructure || !/^[a-f0-9]{64}$/.test(feedback.fingerprint) ||
      !Array.isArray(feedback.failures) || !feedback.failures.length) {
    fail('Repair feedback missing, stale, repeated, or invalid');
  }
  const history = snapshot.convergenceRuns?.[feature.id]?.observations ?? [];
  if (!history.some(h => h.head === feature.head && h.fingerprint === feedback.fingerprint)) {
    fail('Repair requires a persisted deterministic failure observation');
  }
  enforceProviderIsolation(readProviderPolicy(ctx.repo), [feature.backend ?? state.backend], flags, 'repair');
  writeHandoff(state, feature);
  feature.repairBaseHead = feature.head;
  feature.repairCount = (feature.repairCount ?? 0) + 1;
  feature.status = 'pending';
  delete feature.error;
  console.log('Queued bounded repair ' + feature.repairCount + ' for ' + feature.id +
    '; the next approved conductor invocation may start a worker.');
}

function collect(state) {
  if (state.conductor?.enabled && !inspectEvidence(state).complete) {
    fail('Conductor batch requires current acceptance evidence for every criterion before collection');
  }
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
  if (state.conductor?.enabled && !inspectEvidence(state).complete) {
    fail('Conductor acceptance evidence is missing or stale');
  }
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
export async function main(args = process.argv.slice(2), cwd = process.cwd(), options = {}) {
  const [command, id, ...flags] = args;
  if (command === '_worker') return worker(id);
  if (command === 'conduct') {
    const { conduct } = await import('./conductor.mjs');
    console.log(JSON.stringify(await conduct(cwd, id, flags), null, 2));
    return;
  }
  if (command === 'conduct-status') {
    const { conductorStatus } = await import('./conductor.mjs');
    console.log(JSON.stringify(conductorStatus(cwd, id), null, 2));
    return;
  }
  const ctx = context(cwd);
  if (command === 'plan') {
    const requested = json(resolve(cwd, id));
    const policy = readProviderPolicy(ctx.repo);
    const promptSettings = readPromptSettings(ctx.repo);
    // A missing batch backend inherits the configured provider, not a hard-coded
    // Codex default. Explicit batch/feature overrides are checked below.
    const batch = parseBatch({ ...requested, backend: requested.backend ?? policy.configuredBackend });
    const selected = flags.indexOf('--backend');
    if (selected >= 0) {
      const cliBackend = backendName(flags[selected + 1]);
      if (requested.backend !== undefined && requested.backend !== cliBackend) fail('Batch backend conflicts with --backend');
      batch.backend = cliBackend;
    }
    const providerAuthorization = enforceProviderIsolation(policy,
      batch.features.map(f => f.backend ?? batch.backend), flags, 'plan');
    const directory = join(ctx.root, 'batches', batch.id);
    mkdirSync(join(ctx.root, 'batches'), { recursive: true });
    try { mkdirSync(directory); } catch (error) { if (error.code === 'EEXIST') fail('Batch already exists; choose a new id'); throw error; }
    const config = existsSync(join(ctx.repo, 'iwsdk-agent-kit.config.json')) ? json(join(ctx.repo, 'iwsdk-agent-kit.config.json')) : {};
    const baseBranch = requested.baseBranch ?? config.baseBranch ?? 'main';
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(baseBranch) || baseBranch.includes('..')) fail('Invalid base branch');
    const baseline = git(ctx.repo, 'rev-parse', '--verify', `refs/heads/${baseBranch}^{commit}`);
    // Use the committed baseline without modifying the original checkout.
    const state = { ...batch, baseBranch, version: 1, baseline, repo: ctx.repo, root: ctx.root, directory, workflowSource: ctx.repo, worktreeRoot: ctx.worktreeRoot, createdAt: new Date().toISOString(),
      plannedProviderAuthorization: { ...providerAuthorization, at: new Date().toISOString() }, promptSettings };
    state.features = batch.features.map(f => ({ ...f, ...paths(ctx.worktreeRoot, batch.id, f.id), status: 'pending' }));
    save(state); console.log(JSON.stringify(state, null, 2)); return;
  }
  const state = load(ctx, id);
  state.backend = backendName(state.backend); // Pre-migration batches remain Codex-backed.
  if (command === 'status') { refresh(state); console.log(JSON.stringify(state, null, 2)); return; }
  if (command === 'usage') {
    const report = readBatchUsage(state);
    console.log(flags.includes('--json') ? JSON.stringify(report, null, 2) : formatUsageReport(report));
    return;
  }
  await locked(state, async () => {
    switch (command) {
      case 'reconcile': refresh(state); break;
      case 'start': approved(flags); await start(ctx, state, flags, options); break;
      case 'evidence': {
        if (!flags.length || flags.includes('--json')) {
          console.log(JSON.stringify(inspectEvidence(state), null, 2));
          break;
        }
        approved(flags);
        const criterion = flags[1];
        const option = name => {
          const at = flags.indexOf('--' + name);
          return at >= 0 ? flags[at + 1] : undefined;
        };
        const result = recordEvidence(state, flags[0], criterion, {
          status: option('status'), kind: option('kind'),
          artifact: option('artifact'), note: option('note'),
        });
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case 'repair': repair(ctx, state, flags); break;
      case 'collect': collect(state); break;
      case 'integrate': approved(flags); integration(state); break;
      case 'publish': approved(flags); publish(state); break;
      case 'cleanup': approved(flags); cleanup(state); break;
      case 'review-prompt': {
        const f = state.features.find(feature => feature.id === flags[0]);
        if (!f) fail('Specify a valid feature id for review-prompt');
        console.log(writeReviewPrompt(state, f));
        break;
      }
      case 'checkpoint': {
        const targets = flags[0] ? state.features.filter(f => f.id === flags[0]) : state.features;
        if (!targets.length) fail('Unknown feature for checkpoint');
        for (const f of targets) console.log(writeHandoff(state, f));
        break;
      }
      case 'handoff':
      case 'retry': {
        approved(flags);
        const f = state.features.find(x => x.id === flags[0]);
        if (!f || !['failed', 'blocked', 'interrupted'].includes(f.status) || attemptAlive(f)) fail('Only stopped failed/blocked/interrupted workers may be retried');
        const newBackendAt = flags.indexOf('--backend');
        if (command === 'handoff' && newBackendAt < 0) fail('Handoff requires --backend codex|claude|opencode|muse');
        const nextBackend = newBackendAt >= 0 ? backendName(flags[newBackendAt + 1]) : (f.backend ?? state.backend);
        const policy = readProviderPolicy(ctx.repo);
        const providerAuthorization = enforceProviderIsolation(policy, [nextBackend], flags, command);
        const checkpoint = writeHandoff(state, f);
        console.log('Saved checkpoint: ' + checkpoint);
        if (f.attemptDirectory && existsSync(join(f.attemptDirectory, 'claim.json')) && alive(json(join(f.attemptDirectory, 'claim.json')).pid)) fail('Worker claim still alive');
        if (f.attemptDirectory && !existsSync(join(f.attemptDirectory, 'claim.json'))) {
          const fd = openSync(join(f.attemptDirectory, 'claim.json'), 'wx'); writeFileSync(fd, JSON.stringify({ canceled: true })); closeSync(fd);
        }
        if (f.attemptDirectory && existsSync(join(f.attemptDirectory, 'child.json')) && alive(json(join(f.attemptDirectory, 'child.json')).pid)) fail('Worker child still running');
        if (existsSync(f.worktree) && !clean(f.worktree)) fail('Uncommitted work preserved. Inspect the worktree, commit reviewed partial changes, then retry the handoff');
        const previous = f.backend ?? state.backend;
        if (newBackendAt >= 0) {
          f.backend = nextBackend;
          f.handoffs ??= [];
          f.handoffs.push({ from: previous, to: nextBackend, at: new Date().toISOString(), checkpoint, providerAuthorization });
        }
        f.status = 'pending'; delete f.error; break;
      }
      default: fail('Commands: plan FILE | start/conduct/conduct-status/status/usage/evidence/collect/integrate/publish/cleanup ID | evidence ID FEATURE CRITERION --status passed --kind test --artifact FILE --note TEXT --approve | review-prompt ID FEATURE | checkpoint ID [FEATURE] | handoff/retry ID FEATURE --approve | repair ID FEATURE --approve (opt-in convergence only). Cross-provider: --allow-cross-provider BACKEND --approve.');
    }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === self) main().catch(e => { console.error(e.message); process.exitCode = 1; });
