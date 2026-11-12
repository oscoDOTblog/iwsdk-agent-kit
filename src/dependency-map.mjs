import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, posix, resolve, sep } from 'node:path';

const SOURCE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/;
const RESOLVE = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte', '.json'];
const MAX_FILES = 1200, MAX_BYTES = 4 * 1024 * 1024, MAX_FILE = 64 * 1024;
const within = (root, target) => target.startsWith(root + sep);
const normal = value => value.replaceAll('\\', '/');

function trackedSources(root) {
  const r = spawnSync('git', ['ls-files', '-z', '--cached'], {
    cwd: root, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 10000,
  });
  if (r.error || r.status !== 0) throw new Error('Cannot list tracked files for dependency map');
  const names = r.stdout.split('\0').filter(Boolean).map(normal).filter(p =>
    SOURCE.test(p) && !p.startsWith('node_modules/') && !p.startsWith('.git/') && !p.includes('/node_modules/'));
  return { names: names.slice(0, MAX_FILES), truncated: names.length > MAX_FILES };
}

function imports(line) {
  // Conservative line-local static references only; no TS compiler or alias resolution.
  if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return [];
  const patterns = [
    /\b(?:import|export)\s+(?:[^'"]{0,300}?\s+from\s+)?['"](\.[^'"]+)['"]/g,
    /\brequire\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
  ];
  return [...new Set(patterns.flatMap(p => [...line.matchAll(p)].map(m => m[1])))];
}

function resolveImport(source, specifier, known) {
  const base = posix.normalize(posix.join(posix.dirname(source), specifier.split(/[?#]/)[0]));
  if (base === '..' || base.startsWith('../') || base.startsWith('/')) return null;
  const candidates = [base, ...RESOLVE.map(e => base + e), ...RESOLVE.map(e => base + '/index' + e)];
  return candidates.find(p => known.has(p)) ?? null;
}

export function buildDependencyGraph(root) {
  const { names, truncated: fileLimit } = trackedSources(root);
  const known = new Set(names), reverse = new Map(), outgoing = new Map();
  const rootReal = realpathSync(root);
  let bytes = 0, inspected = 0, truncated = fileLimit;
  for (const path of names) {
    const full = resolve(root, path);
    if (!existsSync(full) || !lstatSync(full).isFile() || !within(rootReal, realpathSync(full))) continue;
    const size = statSync(full).size;
    if (size > MAX_FILE) { truncated = true; continue; }
    if (bytes + size > MAX_BYTES) { truncated = true; break; }
    bytes += size; inspected++;
    const lines = readFileSync(full, 'utf8').split(/\r?\n/);
    for (const [i, line] of lines.entries()) {
      if (line.length > 2000) continue;
      for (const specifier of imports(line)) {
        const target = resolveImport(path, specifier, known);
        if (!target) continue;
        const edge = { from: path, to: target, line: i + 1 };
        if (!reverse.has(target)) reverse.set(target, []);
        if (!outgoing.has(path)) outgoing.set(path, []);
        if (!reverse.get(target).some(e => e.from === path && e.line === i + 1)) reverse.get(target).push(edge);
        if (!outgoing.get(path).some(e => e.to === target && e.line === i + 1)) outgoing.get(path).push(edge);
      }
    }
  }
  return { reverse, outgoing, known, inspected, truncated, bytes };
}

export function impactForPaths(graph, ownership, { maxSeeds = 30, maxCallers = 30, depth = 2 } = {}) {
  const owns = ownership.filter(p => typeof p === 'string' && !p.includes('..') && !p.startsWith('/'));
  const all = [...graph.known];
  const seeds = all.filter(p => owns.some(own => own.endsWith('/') ? p.startsWith(own) : p === own));
  const selected = seeds.slice(0, maxSeeds), visited = new Set(selected), callers = [];
  const queue = selected.map(path => ({ path, depth: 0 }));
  let truncated = graph.truncated || seeds.length > maxSeeds;
  while (queue.length) {
    const item = queue.shift();
    if (item.depth >= depth) continue;
    for (const edge of graph.reverse.get(item.path) ?? []) {
      if (visited.has(edge.from)) continue;
      visited.add(edge.from);
      if (callers.length >= maxCallers) { truncated = true; break; }
      callers.push({ path: edge.from, imports: edge.to, line: edge.line, depth: item.depth + 1 });
      queue.push({ path: edge.from, depth: item.depth + 1 });
    }
    if (callers.length >= maxCallers) break;
  }
  const directImports = selected.flatMap(path => (graph.outgoing.get(path) ?? [])
    .map(e => ({ path: e.to, importedBy: e.from, line: e.line }))).slice(0, 30);
  return { seeds: selected, callers, directImports, inspectedFiles: graph.inspected,
    truncated, limitations: 'Relative static JS/TS/Vue/Svelte imports only; aliases, runtime wiring, reflection and assets are not inferred' };
}

export function dependencyImpact(root, ownership) {
  return impactForPaths(buildDependencyGraph(root), ownership);
}

export function changedPathsFromDiff(patch) {
  return [...new Set([...patch.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)].map(m => m[2]))];
}
