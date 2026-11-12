// Opt-in context enrichment. No network access is enabled by default.
export const DEFAULT_CONTEXT = Object.freeze({
  enabled: false,
  dependencyMap: true,
  documentation: Object.freeze({
    enabled: false,
    provider: 'context7',
    maxRequests: 4,
    maxChars: 3000,
    timeoutMs: 8000,
  }),
});
const library = /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const packageName = /^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/;
const version = /^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;
const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

export function validateDocsRequests(requests) {
  if (requests === undefined) return [];
  if (!Array.isArray(requests) || requests.length > 3) throw new Error('docsRequests must be at most three explicit library queries');
  const unique = new Set();
  for (const r of requests) {
    if (!r || typeof r !== 'object' || Array.isArray(r) ||
        Object.keys(r).some(k => !['libraryId', 'package', 'query', 'version'].includes(k)) ||
        !text(r.libraryId, 120) || !library.test(r.libraryId) ||
        !text(r.package, 120) || !packageName.test(r.package) ||
        !text(r.query, 350) || r.query.length < 8 ||
        (r.version !== undefined && (!text(r.version, 60) || !version.test(r.version)))) {
      throw new Error('docsRequests entries need a Context7 libraryId, installed package, bounded query and optional exact version');
    }
    const key = r.libraryId + ':' + r.package + ':' + r.query;
    if (unique.has(key)) throw new Error('docsRequests contains duplicate queries');
    unique.add(key);
  }
  return requests;
}

export function validateContextConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(k => !Object.hasOwn(DEFAULT_CONTEXT, k))) {
    throw new Error('conductor.specialists.context must be an object with known keys');
  }
  const config = { ...DEFAULT_CONTEXT, ...input };
  if (typeof config.enabled !== 'boolean' || typeof config.dependencyMap !== 'boolean') {
    throw new Error('context.enabled and context.dependencyMap must be booleans');
  }
  const docs = config.documentation;
  if (!docs || typeof docs !== 'object' || Array.isArray(docs) ||
      Object.keys(docs).some(k => !Object.hasOwn(DEFAULT_CONTEXT.documentation, k))) {
    throw new Error('context.documentation must be an object with known keys');
  }
  const documentation = { ...DEFAULT_CONTEXT.documentation, ...docs };
  if (documentation.provider !== 'context7' || typeof documentation.enabled !== 'boolean') {
    throw new Error('context.documentation supports only opt-in Context7');
  }
  for (const [key, min, max] of [['maxRequests', 0, 12], ['maxChars', 500, 6000], ['timeoutMs', 1000, 30000]]) {
    const n = documentation[key];
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new Error('context.documentation.' + key + ' must be an integer between ' + min + ' and ' + max);
    }
  }
  if (documentation.enabled && !config.enabled) throw new Error('Enable context before documentation');
  return { ...config, documentation };
}
