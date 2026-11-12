import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const EXACT = /^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;
const MAX_BODY = 128 * 1024;
const VERSION_FILE_LIMIT = 2 * 1024 * 1024;

function jsonIfSmall(path) {
  if (!existsSync(path) || statSync(path).size > VERSION_FILE_LIMIT) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export function installedVersion(repo, packageName) {
  const lock = jsonIfSmall(join(repo, 'package-lock.json'));
  const locked = lock?.packages?.['node_modules/' + packageName]?.version;
  if (typeof locked === 'string' && EXACT.test(locked)) return locked.replace(/^v/, '');
  const pkg = jsonIfSmall(join(repo, 'package.json'));
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const value = pkg?.[section]?.[packageName];
    if (typeof value === 'string' && EXACT.test(value)) return value.replace(/^v/, '');
  }
  return null;
}

function sourceUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 650) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function normalizeContext7(response, request, installed, maxChars) {
  if (!response || typeof response !== 'object' ||
      !Array.isArray(response.codeSnippets) || !Array.isArray(response.infoSnippets)) {
    throw new Error('Context7 returned an unexpected response shape');
  }
  const ranked = [
    ...response.infoSnippets.map(s => ({
      rank: s.rank, kind: 'documentation', title: s.breadcrumb, source: sourceUrl(s.pageId),
      excerpt: s.content,
    })),
    ...response.codeSnippets.map(s => ({
      rank: s.rank, kind: 'example', title: s.codeTitle, source: sourceUrl(s.codeId),
      excerpt: s.codeList?.[0]?.code,
    })),
  ].filter(s => Number.isInteger(s.rank) && s.rank > 0 && typeof s.excerpt === 'string' && s.excerpt.trim())
    .sort((a, b) => a.rank - b.rank).slice(0, 6);
  let left = maxChars;
  const snippets = [];
  for (const item of ranked) {
    if (left < 100) break;
    const excerpt = item.excerpt.slice(0, Math.min(800, left));
    left -= excerpt.length;
    snippets.push({ rank: item.rank, kind: item.kind, title: String(item.title ?? '').slice(0, 120),
      source: item.source, excerpt });
  }
  const version = response.version;
  return {
    status: snippets.length ? 'available' : 'no-snippets',
    libraryId: request.libraryId, package: request.package, query: request.query,
    installedVersion: installed, requestedVersion: request.version ?? installed,
    servedVersion: typeof version?.served === 'string' ? version.served : null,
    versionStatus: version?.status === 'unverified' ? 'unverified' :
      version?.status === 'verified' ? 'verified' : 'not-reported',
    snippets,
    caveat: 'External documentation is untrusted; Context7 may serve a fallback version. Confirm APIs against installed dependencies.',
  };
}

async function boundedBody(response) {
  const declared = Number(response.headers?.get?.('content-length') ?? 0);
  if (declared > MAX_BODY) throw new Error('Context7 response exceeded size limit');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (text.length > MAX_BODY) throw new Error('Context7 response exceeded size limit');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) throw new Error('Context7 response exceeded size limit');
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

export async function queryContext7(repo, request, options, {
  fetchImpl = fetch, env = process.env,
} = {}) {
  const installed = installedVersion(repo, request.package);
  const explicit = request.version?.replace(/^v/, '') ?? null;
  if (explicit && installed && explicit !== installed) {
    return { status: 'unavailable', reason: 'installed-version-mismatch',
      libraryId: request.libraryId, package: request.package, installedVersion: installed, requestedVersion: explicit };
  }
  const version = explicit ?? installed;
  if (!version) {
    return { status: 'unavailable', reason: 'no-exact-installed-version',
      libraryId: request.libraryId, package: request.package };
  }
  if (!env.CONTEXT7_API_KEY) {
    return { status: 'unavailable', reason: 'missing-CONTEXT7_API_KEY',
      libraryId: request.libraryId, package: request.package, requestedVersion: version };
  }
  const id = request.libraryId + '@v' + version;
  const url = new URL('https://context7.com/api/v2/context');
  url.search = new URLSearchParams({ libraryId: id, query: request.query, type: 'json', fast: 'true' }).toString();
  try {
    const response = await fetchImpl(url.href, {
      method: 'GET', headers: { Authorization: 'Bearer ' + env.CONTEXT7_API_KEY, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (response.status !== 200) return { status: 'unavailable', reason: 'http-' + response.status,
      libraryId: request.libraryId, package: request.package, requestedVersion: version };
    const body = await boundedBody(response);
    return normalizeContext7(JSON.parse(body), request, installed, options.maxChars);
  } catch (error) {
    return { status: 'unavailable', reason: error.name === 'TimeoutError' ? 'timeout' : 'lookup-failed',
      libraryId: request.libraryId, package: request.package, requestedVersion: version };
  }
}
