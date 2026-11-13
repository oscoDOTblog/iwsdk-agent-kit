import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep, dirname } from 'node:path';
function atomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = path + '.tmp-' + process.pid;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
  renameSync(temporary, path);
}

const STATES = new Set(['pending', 'passed', 'failed', 'blocked']);
const KINDS = new Set(['test', 'runtime', 'review']);
export const evidencePath = state => join(state.directory, 'acceptance-ledger.json');
function headFor(feature) {
  if (!feature.worktree || !existsSync(feature.worktree)) return null;
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: feature.worktree, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}
function fingerprint(file) {
  const data = readFileSync(file);
  return createHash('sha256').update(data).digest('hex');
}
function artifactFile(state, artifact) {
  if (typeof artifact !== 'string' || !artifact.trim() || isAbsolute(artifact) ||
      artifact.split(/[\\/]/).includes('..') || artifact.includes('\\')) {
    throw new Error('Evidence artifact must be a relative path within the batch directory');
  }
  const root = realpathSync(state.directory);
  const file = resolve(state.directory, artifact);
  if (!existsSync(file) || !lstatSync(file).isFile()) throw new Error('Evidence artifact must be an existing regular file');
  const real = realpathSync(file);
  if (real === root || !real.startsWith(root + sep)) throw new Error('Evidence artifact escapes the batch directory');
  const size = statSync(real).size;
  if (size < 1 || size > 4 * 1024 * 1024) throw new Error('Evidence artifact must be 1 byte to 4 MB');
  return { file: real, path: relative(root, real), sha256: fingerprint(real) };
}
export function syncEvidence(state, existing = null) {
  const prior = existing ?? (existsSync(evidencePath(state)) ? JSON.parse(readFileSync(evidencePath(state), 'utf8')) : null);
  const ledger = { version: 1, batch: state.id, features: {} };
  for (const f of state.features) {
    const old = prior?.features?.[f.id];
    const head = f.head ?? null;
    const unchanged = old?.head === head &&
      old?.criteria?.length === f.acceptance.length &&
      old.criteria.every((c, i) => c.criterion === f.acceptance[i]);
    ledger.features[f.id] = {
      head,
      criteria: unchanged ? old.criteria : f.acceptance.map(criterion => ({
        criterion, status: 'pending', evidence: null,
      })),
    };
  }
  return ledger;
}
export function saveEvidence(state, ledger) { atomic(evidencePath(state), ledger); }
export function recordEvidence(state, featureId, criterionNumber, input) {
  const feature = state.features.find(f => f.id === featureId);
  if (!feature || !['completed', 'collected'].includes(feature.status) || !feature.head) {
    throw new Error('Evidence requires a completed feature with a recorded commit');
  }
  if (headFor(feature) !== feature.head) throw new Error('Feature HEAD changed; evidence cannot be recorded');
  const index = Number(criterionNumber) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= feature.acceptance.length) {
    throw new Error('Criterion must be a 1-based acceptance index');
  }
  const { status, kind, artifact, note } = input;
  if (!STATES.has(status)) throw new Error('Invalid evidence status');
  if (status !== 'pending' && (typeof note !== 'string' || !note.trim() || note.length > 2000)) {
    throw new Error('Evidence note is required (up to 2000 characters)');
  }
  if (status === 'passed' && (!KINDS.has(kind) || !artifact)) {
    throw new Error('Passing evidence requires --kind test|runtime|review and --artifact');
  }
  const file = artifact ? artifactFile(state, artifact) : null;
  const ledger = syncEvidence(state);
  ledger.features[featureId].criteria[index] = {
    criterion: feature.acceptance[index], status,
    evidence: status === 'pending' ? null : {
      head: feature.head, kind: kind ?? 'review', artifact: file?.path ?? null,
      sha256: file?.sha256 ?? null, note, recordedAt: new Date().toISOString(),
      recordedBy: 'explicit CLI approval (not autonomous model verification)',
    },
  };
  saveEvidence(state, ledger);
  return ledger.features[featureId].criteria[index];
}
export function inspectEvidence(state) {
  const ledger = syncEvidence(state);
  const findings = [];
  let complete = true;
  for (const f of state.features) {
    const entry = ledger.features[f.id];
    if (!['completed', 'collected'].includes(f.status) || !f.head || headFor(f) !== f.head) {
      complete = false;
      findings.push({ feature: f.id, status: 'pending', reason: 'Feature not completed at recorded commit' });
      continue;
    }
    for (const [index, criterion] of entry.criteria.entries()) {
      if (criterion.status !== 'passed') {
        complete = false;
        findings.push({ feature: f.id, criterion: index + 1, status: criterion.status, reason: 'Acceptance not passed' });
        continue;
      }
      const proof = criterion.evidence;
      if (!proof || proof.head !== f.head || !proof.artifact || !proof.sha256) {
        complete = false;
        findings.push({ feature: f.id, criterion: index + 1, status: 'stale', reason: 'Missing or stale commit-bound evidence' });
        continue;
      }
      try {
        const file = artifactFile(state, proof.artifact);
        if (file.sha256 !== proof.sha256) throw new Error('Artifact content changed');
      } catch (e) {
        complete = false;
        findings.push({ feature: f.id, criterion: index + 1, status: 'stale', reason: e.message });
      }
    }
  }
  return { ...ledger, complete, findings,
    caveat: 'A matching artifact and commit do not prove correctness; explicit human review is still required.' };
}
