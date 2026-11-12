#!/usr/bin/env node
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_FILES = 500, MAX_BYTES = 256 * 1024;
const risk = (file, line, issue, impact, fix) => ({ file, line, issue, impact, fix });
function lineAt(content, pattern) {
  const index = content.search(pattern);
  return index < 0 ? 1 : content.slice(0, index).split('\n').length;
}
function scanMarkdown(file, content, findings) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return;
  const front = match[1];
  if (/^\s*model:\s*\S+/m.test(front) && !/^\s*context:\s*fork\b/m.test(front)) {
    findings.push(risk(file, lineAt(content, /^\s*model:\s*\S+/m), 'Skill pins a model without context: fork',
      'Possible main-session cache change', 'Run the skill in a forked context where supported'));
  }
}
function scanJson(file, content, findings) {
  let parsed;
  try { parsed = JSON.parse(content); }
  catch { findings.push(risk(file, 1, 'Invalid JSON configuration', 'Cannot audit settings reliably', 'Fix JSON syntax')); return; }
  const deny = parsed.permissions?.deny;
  if (Array.isArray(deny)) for (const tool of deny) {
    if (['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'].includes(tool)) {
      findings.push(risk(file, lineAt(content, new RegExp('"' + tool + '"')),
        'Whole-tool permission denial: ' + tool,
        'May alter tool configuration and cache prefixes', 'Prefer scoped permission rules where security requirements allow'));
    }
  }
  if (parsed.env && Object.hasOwn(parsed.env, 'ANTHROPIC_BASE_URL')) {
    findings.push(risk(file, lineAt(content, /"ANTHROPIC_BASE_URL"/),
      'Custom Anthropic API endpoint configured',
      'Gateway cache support is unknown', 'Verify cache metrics with your gateway; do not assume cache reuse'));
  }
  if (parsed.env?.ENABLE_TOOL_SEARCH === 'false' || parsed.env?.DISABLE_TOOL_SEARCH === 'true' ||
      parsed.toolSearch === false) {
    findings.push(risk(file, lineAt(content, /"(?:(?:ENABLE|DISABLE)_TOOL_SEARCH|toolSearch)"/),
      'Tool search may be disabled', 'Tool-list changes may invalidate cached prefixes',
      'Verify tool search behavior for your CLI version'));
  }
  for (const key of ['promptCacheTtl', 'subagentPromptCacheTtl']) if (Object.hasOwn(parsed, key)) {
    findings.push(risk(file, lineAt(content, new RegExp('"' + key + '"')),
      key + ' is explicitly configured', 'Cache write/expiry tradeoff depends on plan and CLI version',
      'Review actual cache hit rate before changing TTL'));
  }
}
function safeRead(path) {
  try {
    if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).size > MAX_BYTES) return null;
    return readFileSync(path, 'utf8');
  } catch { return null; }
}
function markdownFiles(root) {
  const found = [];
  function walk(dir) {
    if (found.length >= MAX_FILES) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (found.length >= MAX_FILES || entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) found.push(path);
    }
  }
  walk(join(root, 'skills'));
  walk(join(root, 'commands'));
  return found;
}
export function auditCacheConfig(root = process.cwd(), { home = homedir(), env = process.env } = {}) {
  const findings = [], visited = new Set();
  const roots = [join(resolve(root), '.claude'), join(resolve(home), '.claude')];
  const files = [
    ...roots.flatMap(dir => [
      join(dir, 'settings.json'), join(dir, 'settings.local.json'),
      ...markdownFiles(dir),
    ]),
    join(resolve(root), '.mcp.json'),
  ];
  for (const file of files) {
    if (visited.has(file)) continue;
    visited.add(file);
    const content = safeRead(file);
    if (content === null) continue;
    if (file.endsWith('.md')) scanMarkdown(file, content, findings);
    else scanJson(file, content, findings);
  }
  if (env.ANTHROPIC_BASE_URL) {
    findings.push(risk('environment', 0, 'ANTHROPIC_BASE_URL is set',
      'Custom endpoint cache behavior is unknown', 'Verify caching with your gateway; endpoint value is never displayed'));
  }
  if (env.ENABLE_TOOL_SEARCH === 'false' || env.DISABLE_TOOL_SEARCH === 'true') {
    findings.push(risk('environment', 0, 'Tool search override may disable deferred tools',
      'Possible cache prefix invalidation', 'Verify tool search behavior for your CLI version'));
  }
  return { root: resolve(root), scannedFiles: visited.size, findings,
    caveat: 'Read-only heuristic audit. No settings were changed; flags are not proof of cache misses.' };
}
export function formatCacheAudit(report) {
  if (!report.findings.length) return 'No potential cache breakers detected in inspected files. ' + report.caveat;
  return ['File | Line | Issue | Possible impact | Suggested action',
    '--- | ---: | --- | --- | ---',
    ...report.findings.map(f => [f.file, f.line, f.issue, f.impact, f.fix]
      .map(v => String(v).replaceAll('|', '/').replaceAll('\n', ' ')).join(' | ')),
    '', report.caveat].join('\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const target = args.indexOf('--target');
  const root = target >= 0 ? resolve(args[target + 1]) : process.cwd();
  const report = auditCacheConfig(root);
  console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : formatCacheAudit(report));
}
