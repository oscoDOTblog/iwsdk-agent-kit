import { investigationPrompt, runSpecialist, saveInvestigation, captureFeatureDiff,
  runTargetedTests, checkerPrompt, saveCheck } from './specialists.mjs';
import { run } from './orchestrator.mjs';

export function specialistRuns(conductor) {
  conductor.specialistRuns ??= { calls: [], investigations: {}, checks: {} };
  return conductor.specialistRuns;
}

export function canInvoke(conductor, cfg, role) {
  const calls = specialistRuns(conductor).calls;
  const limit = role === 'explorer' ? cfg.specialists.maxExplorerCalls : cfg.specialists.maxCheckerCalls;
  return calls.length < cfg.specialists.maxCalls && calls.filter(c => c.role === role).length < limit;
}

function reserve(state, conductor, cfg, role, feature, persist) {
  if (!canInvoke(conductor, cfg, role)) return null;
  const call = { role, feature: feature.id, head: feature.head ?? state.baseline,
    status: 'started', at: new Date().toISOString() };
  specialistRuns(conductor).calls.push(call);
  // Persist before inference; a crash cannot silently repeat a paid call.
  persist(state, conductor);
  return call;
}

function failure(state, conductor, role, feature, call, error, persist, note) {
  call.status = 'failed'; call.error = error.message;
  const runs = specialistRuns(conductor);
  const map = role === 'explorer' ? runs.investigations : runs.checks;
  map[feature.id] = { head: feature.head ?? state.baseline, status: 'failed', error: error.message };
  conductor.lastError = error.message;
  note(conductor, 'specialist-blocked', role + ' failed for ' + feature.id + '; explicit review required');
  persist(state, conductor);
}

export function exploreFeature(state, conductor, cfg, feature, persist, note) {
  const call = reserve(state, conductor, cfg, 'explorer', feature, persist);
  if (!call) {
    note(conductor, 'specialist-budget-exhausted', 'Explorer invocation limit reached');
    persist(state, conductor); return false;
  }
  try {
    const result = runSpecialist(state, cfg, 'explorer', feature, investigationPrompt(state, feature));
    const saved = saveInvestigation(state, feature, result);
    Object.assign(call, { status: 'completed', usage: result.usage, model: result.model, provider: result.provider });
    specialistRuns(conductor).investigations[feature.id] = { head: state.baseline, status: 'completed',
      files: saved.data.files, summary: saved.data.summary };
    note(conductor, 'explored', 'Read-only file references recorded for ' + feature.id);
    persist(state, conductor); return true;
  } catch (error) {
    failure(state, conductor, 'explorer', feature, call, error, persist, note);
    return false;
  }
}

export function checkFeature(state, conductor, cfg, feature, persist, note) {
  if (!canInvoke(conductor, cfg, 'checker')) {
    note(conductor, 'specialist-budget-exhausted', 'Checker invocation limit reached');
    persist(state, conductor); return false;
  }
  try {
    const diff = captureFeatureDiff(state, feature, cfg.specialists.maxDiffChars);
    const tests = runTargetedTests(state, feature, cfg.specialists.maxTestSeconds);
    if (!diff.patch || diff.truncated) {
      const reason = !diff.patch ? 'No inspectable patch' : 'Diff exceeds configured checker context limit';
      specialistRuns(conductor).checks[feature.id] = { head: feature.head, status: 'needs-human',
        reason, diff: { sha256: diff.sha256, chars: diff.chars, truncated: diff.truncated }, tests };
      note(conductor, 'checker-needs-human', feature.id + ': ' + reason);
      persist(state, conductor); return true;
    }
    if (run('git', ['status', '--porcelain', '--untracked-files=all'], feature.worktree)) {
      specialistRuns(conductor).checks[feature.id] = { head: feature.head, status: 'needs-human',
        reason: 'Targeted tests left a dirty worktree; no files were discarded', tests };
      note(conductor, 'checker-needs-human', feature.id + ': tests left uncommitted changes');
      persist(state, conductor); return true;
    }
    const call = reserve(state, conductor, cfg, 'checker', feature, persist);
    if (!call) return false;
    try {
      const result = runSpecialist(state, cfg, 'checker', feature, checkerPrompt(feature, diff, tests));
      const saved = saveCheck(state, feature, diff, tests, result);
      Object.assign(call, { status: 'completed', usage: result.usage, model: result.model, provider: result.provider });
      specialistRuns(conductor).checks[feature.id] = { head: feature.head, status: saved.status,
        findings: saved.data.findings, tests, diff: saved.diff };
      note(conductor, 'checked', 'Independent diff review recorded for ' + feature.id + ': ' + saved.status);
      persist(state, conductor); return true;
    } catch (error) {
      failure(state, conductor, 'checker', feature, call, error, persist, note);
      return false;
    }
  } catch (error) {
    specialistRuns(conductor).checks[feature.id] = { head: feature.head, status: 'failed', error: error.message };
    conductor.lastError = error.message;
    note(conductor, 'specialist-blocked', 'Checker preparation failed for ' + feature.id);
    persist(state, conductor); return false;
  }
}
