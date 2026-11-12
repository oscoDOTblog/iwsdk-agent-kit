import { existsSync, readFileSync, openSync, closeSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { run, atomic, ready, main as batchMain } from './orchestrator.mjs';
import { readConductorConfig, DEFAULT_SPECIALISTS, validateConvergenceConfig } from './conductor-config.mjs';
import { validateContextConfig } from './context-config.mjs';
import { plannerPrompt, verifierPrompt, runCoordinatorRole } from './conductor-ai.mjs';
import { syncEvidence, saveEvidence, inspectEvidence } from './evidence.mjs';
import { readProviderPolicy, enforceProviderIsolation } from './provider-policy.mjs';
import { specialistRuns, exploreFeature, checkFeature } from './specialist-conductor.mjs';
import { observeFailure, canRepair } from './convergence.mjs';

const json = path => JSON.parse(readFileSync(path, 'utf8'));
const conductorPath = state => join(state.directory, 'conductor.json');
const statePath = state => join(state.directory, 'state.json');
const started = state => state.features.reduce((count, f) => count + (f.attempt ?? 0), 0);
const statuses = state => Object.fromEntries(state.features.map(f => [f.id, f.status]));
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function withLock(directory, fn) {
  const path = join(directory, 'conductor.lock');
  if (existsSync(path)) {
    const prior = json(path);
    if (alive(prior.pid)) throw new Error('Conductor already running at PID ' + prior.pid);
    rmSync(path);
  }
  const fd = openSync(path, 'wx');
  writeFileSync(fd, JSON.stringify({ pid: process.pid }));
  closeSync(fd);
  return Promise.resolve().then(fn).finally(() => rmSync(path, { force: true }));
}
function location(cwd, id) {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(id ?? '')) throw new Error('Supply a valid batch ID');
  const repo = run('git', ['rev-parse', '--show-toplevel'], cwd);
  const common = resolve(cwd, run('git', ['rev-parse', '--git-common-dir'], cwd));
  const directory = join(common, 'agent-workflow', 'batches', id);
  if (!existsSync(join(directory, 'state.json'))) throw new Error('Unknown batch: ' + id);
  return { repo, directory };
}
function persist(state, conductor) {
  atomic(conductorPath(state), conductor);
}
function currentState(directory) { return json(join(directory, 'state.json')); }
function snapshot(state, cfg) {
  const file = conductorPath(state);
  if (existsSync(file)) return json(file);
  return {
    version: 1, batch: state.id, config: cfg, phase: 'initializing',
    createdAt: new Date().toISOString(), plan: null, verification: null,
    events: [], lastError: null,
  };
}
function note(conductor, phase, detail) {
  conductor.phase = phase;
  conductor.updatedAt = new Date().toISOString();
  conductor.events.push({ phase, at: conductor.updatedAt, detail });
  conductor.events = conductor.events.slice(-100);
}
function retryable(feature, cfg) {
  if (feature.status !== 'failed' || (feature.attempt ?? 0) > cfg.maxRetriesPerFeature) return false;
  const error = feature.error ?? '';
  if (/\b(?:quota|usage.limit|usage.cap|credits|rate.limit|permission|unauthorized|auth|denied|blocked)\b/i.test(error)) return false;
  return /\b(?:ETIMEDOUT|ECONNRESET|EAI_AGAIN|temporar(?:y|ily)|timed? out)\b/i.test(error);
}
function remaining(state, cfg) { return cfg.maxWorkerStarts - started(state); }
function report(state, conductor) {
  const ledger = inspectEvidence(state);
  return {
    batch: state.id, mode: 'conductor', phase: conductor.phase,
    provider: conductor.config.provider, workerStatuses: statuses(state),
    workerStarts: started(state), maxWorkerStarts: conductor.config.maxWorkerStarts,
    plan: conductor.plan, verification: conductor.verification,
    evidence: { complete: ledger.complete, findings: ledger.findings },
    lastError: conductor.lastError,
    specialists: conductor.config.specialists?.enabled ? specialistRuns(conductor) : { enabled: false },
    convergence: conductor.config.convergence?.enabled ? {
      enabled: true,
      maxRepairsPerFeature: conductor.config.convergence.maxRepairsPerFeature,
      features: Object.fromEntries(state.features.map(f => [f.id, {
        repairs: f.repairCount ?? 0,
        failures: conductor.convergenceRuns?.[f.id]?.observations?.length ?? 0,
      }])),
    } : { enabled: false },
    contextLookups: conductor.config.specialists?.context?.enabled ?
      (conductor.contextLookups ?? []).map(c => ({ feature: c.feature, libraryId: c.libraryId,
        status: c.status, reason: c.reason ?? null })) : [],
    caveat: 'No automatic integration, publishing, cross-provider failover, or proof of runtime acceptance.',
  };
}
export function conductorStatus(cwd, id) {
  const { directory } = location(cwd, id);
  const state = currentState(directory);
  const path = conductorPath(state);
  if (!existsSync(path)) return { batch: id, mode: 'manual', workerStatuses: statuses(state),
    message: 'No conductor has been started for this batch' };
  return report(state, json(path));
}
export async function conduct(cwd, id, flags = []) {
  if (!flags.includes('--approve')) throw new Error('Conductor requires explicit --approve; no provider calls were made');
  const { repo, directory } = location(cwd, id);
  const config = readConductorConfig(repo);
  if (!config.enabled) throw new Error('Conductor is disabled; set conductor.enabled=true to opt in');
  return withLock(directory, async () => {
    let state = currentState(directory);
    let conductor = snapshot(state, config);
    const cfg = conductor.config; // Stable across resumptions; edit a new batch to change limits.
    cfg.specialists ??= { ...DEFAULT_SPECIALISTS, models: {} }; // Older v0.5 snapshots stay opt-out.
    cfg.specialists.context ??= validateContextConfig(); // Older v0.6 snapshots stay opt-out.
    cfg.convergence ??= validateConvergenceConfig(); // Older v0.7 snapshots stay opt-out.
    const workers = state.features.filter(f => ['pending', 'running'].includes(f.status))
      .map(f => f.backend ?? state.backend);
    const providers = [...workers, ...((cfg.aiPlanning || cfg.aiVerification ||
      (cfg.specialists.enabled && (cfg.specialists.explore || cfg.specialists.check))) ? [cfg.provider] : [])];
    if (cfg.specialists.enabled && cfg.specialists.models.fixer &&
        state.features.some(f => (f.backend ?? state.backend) !== cfg.provider)) {
      throw new Error('Specialist fixer model requires implementation workers on the conductor provider; no model launched');
    }
    enforceProviderIsolation(readProviderPolicy(repo), providers, flags, 'conduct');
    if (!state.conductor?.enabled) {
      state.conductor = { enabled: true, priority: state.features.map(f => f.id) };
      atomic(statePath(state), state);
    }
    if (cfg.convergence.enabled) {
      state.conductor.convergenceEnabled = true;
      atomic(statePath(state), state);
    }
    if (cfg.specialists.enabled && cfg.specialists.context.enabled) {
      state.conductor.contextEnabled = true;
      atomic(statePath(state), state);
    }
    if (cfg.specialists.enabled && cfg.specialists.models.fixer) {
      state.conductor.fixerModel = cfg.specialists.models.fixer;
      state.conductor.fixerProvider = cfg.provider;
      atomic(statePath(state), state);
    }
    if (!conductor.plan) {
      note(conductor, 'planning', 'Preparing approved feature order');
      persist(state, conductor);
      if (cfg.aiPlanning) {
        const result = runCoordinatorRole(state, cfg, 'planner', plannerPrompt(state));
        conductor.plan = result;
      } else {
        conductor.plan = { data: { priority: state.features.map(f => f.id), risks: [], notes: 'Deterministic input order' },
          provider: null, model: null, usage: null };
      }
      state = currentState(directory);
      state.conductor.priority = conductor.plan.data.priority;
      atomic(statePath(state), state);
      note(conductor, 'planned', 'Planner may prioritize only approved features');
      persist(state, conductor);
    }
    const deadlineAt = Date.now() + cfg.maxRunMinutes * 60_000;
    const maxLoops = state.features.length * (cfg.maxRetriesPerFeature + 2) + 3;
    for (let cycle = 0; cycle < maxLoops; cycle++) {
      state = currentState(directory);
      if (state.features.some(f => f.status === 'running')) {
        // Reconcile detached workers even after the launch budget is exhausted.
        // This does not run a provider or start a new worker.
        await batchMain(['reconcile', id], repo);
        state = currentState(directory);
      }
      if (state.features.every(f => ['completed', 'collected'].includes(f.status))) break;
      if (Date.now() >= deadlineAt) {
        note(conductor, 'paused', 'Scheduling time limit reached; detached workers may still be running');
        persist(state, conductor);
        return report(state, conductor);
      }
      if (remaining(state, cfg) <= 0) {
        const active = state.features.some(f => f.status === 'running');
        note(conductor, active ? 'running' : 'budget-exhausted',
          active ? 'Launch budget exhausted; existing workers remain active and can be reconciled later' :
            'Total worker start limit reached');
        persist(state, conductor);
        return report(state, conductor);
      }
      const failed = state.features.find(f => retryable(f, cfg));
      if (failed) {
        note(conductor, 'retrying', 'Retrying transient failure for ' + failed.id);
        persist(state, conductor);
        try { await batchMain(['retry', id, failed.id, ...flags], repo); }
        catch (error) {
          conductor.lastError = error.message;
          note(conductor, 'needs-attention', 'Retry blocked by existing safety checks');
          persist(state, conductor);
          return report(currentState(directory), conductor);
        }
        continue;
      }
      const active = state.features.some(f => ['pending', 'running'].includes(f.status));
      if (!active) break;
      if (cfg.specialists.enabled && cfg.specialists.explore) {
        const pending = ready(state);
        const next = pending.find(f => !specialistRuns(conductor).investigations[f.id]);
        if (next) {
          if (!await exploreFeature(state, conductor, cfg, next, persist, note)) return report(state, conductor);
          continue;
        }
        if (pending.some(f => specialistRuns(conductor).investigations[f.id]?.status !== 'completed')) {
          note(conductor, 'specialist-blocked', 'Explorer report needs human attention');
          persist(state, conductor); return report(state, conductor);
        }
      }
      note(conductor, 'dispatching', 'Running existing bounded worker scheduler');
      persist(state, conductor);
      const before = started(state);
      try {
        await batchMain(['start', id, ...flags], repo, {
          conductor: { maxStarts: remaining(state, cfg), maxConcurrency: cfg.maxParallelWorkers, deadlineAt },
        });
      } catch (error) {
        conductor.lastError = error.message;
      }
      state = currentState(directory);
      if (state.features.some(f => f.status === 'running')) {
        note(conductor, 'running', 'Workers remain active; rerun conduct to resume monitoring');
        persist(state, conductor);
        return report(state, conductor);
      }
      if (started(state) === before && !state.features.some(f => retryable(f, cfg))) break;
    }
    state = currentState(directory);
    if (!state.features.every(f => ['completed', 'collected'].includes(f.status))) {
      note(conductor, 'needs-attention', 'Review failed, interrupted, blocked, or dependency-stalled features');
      persist(state, conductor);
      return report(state, conductor);
    }
    const ledger = syncEvidence(state);
    saveEvidence(state, ledger);
    if (cfg.specialists.enabled && cfg.specialists.check) {
      for (const feature of state.features) {
        const prior = specialistRuns(conductor).checks[feature.id];
        if (prior?.head === feature.head) {
          if (prior.status === 'failed' || prior.status === 'started') {
            note(conductor, 'specialist-blocked', 'Previous checker invocation was interrupted or failed; explicit review required');
            persist(state, conductor); return report(state, conductor);
          }
          continue;
        }
        if (Date.now() >= deadlineAt) {
          note(conductor, 'paused', 'Time limit reached before independent checking');
          persist(state, conductor); return report(state, conductor);
        }
        if (!checkFeature(state, conductor, cfg, feature, persist, note)) return report(state, conductor);
      }
    }
    if (cfg.convergence.enabled) {
      const checks = specialistRuns(conductor).checks;
      const failed = state.features.find(f => checks[f.id]?.head === f.head &&
        checks[f.id]?.status === 'failed-tests');
      if (failed) {
        const feedback = observeFailure(state, conductor, failed, checks[failed.id].tests, cfg, persist);
        const decision = canRepair(state, conductor, failed, feedback, cfg);
        if (!decision.allowed) {
          note(conductor, 'convergence-stopped', failed.id + ': ' + decision.reason);
          persist(state, conductor); return report(state, conductor);
        }
        if (Date.now() >= deadlineAt) {
          note(conductor, 'paused', 'Convergence scheduling deadline reached before repair');
          persist(state, conductor); return report(state, conductor);
        }
        try {
          // The normal coordinator enforces clean HEAD, owned paths, unchanged provider,
          // dependency safety, explicit approval and both worker/repair budgets.
          await batchMain(['repair', id, failed.id, ...flags], repo);
          state = currentState(directory);
          note(conductor, 'repair-queued', failed.id + ': bounded repair queued with deterministic feedback; rerun conduct --approve to launch');
          persist(state, conductor); return report(state, conductor);
        } catch (error) {
          conductor.lastError = error.message;
          note(conductor, 'convergence-stopped', failed.id + ': repair blocked by safety checks');
          persist(state, conductor); return report(currentState(directory), conductor);
        }
      }
      const needsReview = state.features.find(f => checks[f.id]?.head === f.head &&
        !['pass'].includes(checks[f.id]?.status));
      if (needsReview) {
        note(conductor, 'convergence-stopped', needsReview.id + ': checker or regression proof requires human review');
        persist(state, conductor); return report(state, conductor);
      }
    }
    const revision = state.features.map(f => f.id + ':' + f.head).join('|');
    if (cfg.aiVerification && conductor.verification?.revision !== revision) {
      note(conductor, 'verifying', 'Requesting advisory review; no acceptance items can be auto-approved');
      persist(state, conductor);
      try {
        conductor.verification = { ...runCoordinatorRole(state, cfg, 'verifier', verifierPrompt(state, ledger)), revision };
      } catch (error) {
        conductor.lastError = error.message;
        note(conductor, 'verification-blocked', 'Verifier failed; manual acceptance ledger remains available');
        persist(state, conductor);
        return report(state, conductor);
      }
    }
    const evidence = inspectEvidence(state);
    note(conductor, evidence.complete ? 'ready-for-collection' : 'awaiting-evidence',
      evidence.complete ? 'All acceptance evidence is current; manual collection and review still required' :
        'Record independent evidence for each criterion with agents:evidence');
    persist(state, conductor);
    return report(state, conductor);
  });
}
