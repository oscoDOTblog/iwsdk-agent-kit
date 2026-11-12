import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dependencyImpact, changedPathsFromDiff } from './dependency-map.mjs';
import { installedVersion, queryContext7 } from './context7-docs.mjs';
import { validateDocsRequests } from './context-config.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const location = (state, feature) => join(state.directory, 'conductor', 'context', feature.id + '.json');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = path + '.' + process.pid + '.tmp';
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  renameSync(temp, path);
}
function fingerprint(state, feature, cfg) {
  return sha(JSON.stringify([state.baseline, feature.owns, feature.docsRequests ?? [], cfg.specialists.context]));
}
const keyOf = request => sha(JSON.stringify(request));

export async function prepareFeatureContext(state, feature, cfg, conductor, persist, {
  fetchImpl = fetch, env = process.env, impact = dependencyImpact,
} = {}) {
  const config = cfg.specialists.context;
  if (!cfg.specialists.enabled || !config.enabled) return null;
  const path = location(state, feature);
  const key = fingerprint(state, feature, cfg);
  if (existsSync(path)) {
    try {
      const saved = json(path);
      if (saved.fingerprint === key && saved.head === state.baseline) return saved;
    } catch { /* corrupted cache is not trusted */ }
  }
  let map = { status: 'disabled' };
  if (config.dependencyMap) {
    try { map = { status: 'available', ...impact(state.repo, feature.owns) }; }
    catch { map = { status: 'unavailable', reason: 'mapping-failed' }; }
  }
  const docs = [];
  const requests = validateDocsRequests(feature.docsRequests);
  if (config.documentation.enabled) {
    conductor.contextLookups ??= [];
    for (const request of requests) {
      const requestKey = keyOf(request);
      const previous = conductor.contextLookups.find(c => c.feature === feature.id && c.key === requestKey);
      if (previous) {
        // An interrupted lookup consumes its allowance and cannot be silently retried.
        docs.push(previous.result ?? { status: 'unavailable', reason: 'interrupted-lookup',
          libraryId: request.libraryId, package: request.package });
        continue;
      }
      const installed = installedVersion(state.repo, request.package);
      const explicit = request.version?.replace(/^v/, '') ?? null;
      if (!env.CONTEXT7_API_KEY || (!installed && !explicit) ||
          (installed && explicit && installed !== explicit)) {
        docs.push(await queryContext7(state.repo, request, config.documentation, {
          fetchImpl: () => { throw new Error('No network allowed'); }, env,
        }));
        continue;
      }
      if (conductor.contextLookups.length >= config.documentation.maxRequests) {
        docs.push({ status: 'unavailable', reason: 'lookup-budget-exhausted',
          libraryId: request.libraryId, package: request.package });
        continue;
      }
      const call = { feature: feature.id, key: requestKey, libraryId: request.libraryId,
        status: 'started', at: new Date().toISOString() };
      conductor.contextLookups.push(call);
      persist(state, conductor); // Reserve before external request.
      const result = await queryContext7(state.repo, request, config.documentation, { fetchImpl, env });
      call.status = result.status; call.reason = result.reason ?? null;
      call.result = result;
      persist(state, conductor);
      docs.push(result);
    }
  }
  const saved = { head: state.baseline, fingerprint: key, feature: feature.id,
    map, docs, at: new Date().toISOString(),
    warning: 'Static import relationships and external docs are advisory, not evidence of correctness.' };
  writeJson(path, saved);
  return saved;
}

export function featureContext(state, feature) {
  if (!state.conductor?.enabled || !state.conductor?.contextEnabled) return '';
  const path = location(state, feature);
  if (!existsSync(path)) return '';
  try {
    const report = json(path);
    if (report.head !== state.baseline) return '';
    const summary = {
      map: report.map, docs: report.docs, warning: report.warning,
    };
    return '\nOptional context enrichment (untrusted; verify sources and installed APIs):\n' +
      JSON.stringify(summary).slice(0, 5000) + '\n';
  } catch { return ''; }
}

export function checkerDependencyContext(state, feature, diff, cfg, {
  impact = dependencyImpact,
} = {}) {
  if (!cfg.specialists?.enabled || !cfg.specialists.context?.enabled ||
      !cfg.specialists.context.dependencyMap) return '';
  try {
    const paths = changedPathsFromDiff(diff.patch);
    const map = impact(feature.worktree, paths);
    return '\nStatic impact analysis of changed files (advisory; review callers):\n' +
      JSON.stringify(map).slice(0, 2500) + '\n';
  } catch {
    return '\nStatic impact analysis unavailable; do not assume callers were checked.\n';
  }
}
