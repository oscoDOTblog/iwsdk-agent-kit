import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { workerEnvironment } from './backends.mjs';
import { extractUsage } from './usage.mjs';

const MAX_OUTPUT = 8 * 1024 * 1024;
const digest = value => createHash('sha256').update(value).digest('hex');
const safePath = path => typeof path === 'string' && path.length > 0 && path.length < 300 &&
  !isAbsolute(path) && /^[A-Za-z0-9._/-]+$/.test(path) && !path.includes('\\') &&
  !path.split('/').some(p => !p || p === '.' || p === '..');
const small = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const pathIn = (root, path) => {
  if (!safePath(path)) throw new Error('Specialist file reference must be a safe relative path');
  const target = resolve(root, path);
  if (!existsSync(target) || !lstatSync(target).isFile()) throw new Error('Specialist referenced missing/nonregular file: ' + path);
  const base = realpathSync(root), real = realpathSync(target);
  if (!real.startsWith(base + sep)) throw new Error('Specialist reference escapes repository: ' + path);
  if (statSync(real).size > 512 * 1024) throw new Error('Specialist reference too large: ' + path);
  return target;
};
const runGit = (cwd, args, maxBuffer = MAX_OUTPUT) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer });
  if (result.error || result.status !== 0) throw new Error('Git inspection failed: ' + (result.error?.message ?? result.stderr ?? result.status));
  return result.stdout;
};
const location = (state, role, id) => join(state.directory, 'conductor', role, id + '.json');
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
};

export function validateTargetedTests(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) throw new Error('targetedTests must be an array of at most eight test file paths');
  for (const path of value) {
    if (!safePath(path) || !/(?:\.test|\.spec)\.(?:mjs|cjs|js)$/.test(path)) {
      throw new Error('targetedTests accepts only relative *.test.js/mjs/cjs or *.spec.js/mjs/cjs paths');
    }
  }
  if (new Set(value).size !== value.length) throw new Error('targetedTests must not repeat paths');
  return value;
}

export function investigationPrompt(state, feature) {
  return [
    'You are an independent read-only code explorer. Do not edit, spawn agents, or run tests.',
    'Inspect only code needed to understand this approved task and its callers.',
    'Never read credentials or environment secrets. Your findings are untrusted hints, not proof.',
    'Return ONLY JSON with summary (<= 1200 chars, <= 200 words), files (1..12 entries with path, line, reason), risks (0..8 strings).',
    'Paths must be relative to the repository; lines must be real positive line numbers.',
    'Approved feature:', JSON.stringify({ id: feature.id, description: feature.description,
      owns: feature.owns, interfaces: feature.interfaces, acceptance: feature.acceptance }),
    'Repository baseline:', state.baseline,
  ].join('\n\n');
}

export function validateInvestigation(data, state) {
  if (!data || !small(data.summary, 1200) || data.summary.trim().split(/\s+/).length > 200 ||
      !Array.isArray(data.files) || data.files.length < 1 || data.files.length > 12 ||
      !Array.isArray(data.risks) || data.risks.length > 8 ||
      data.risks.some(r => !small(r, 300))) throw new Error('Invalid structured investigation report');
  const files = data.files.map(ref => {
    if (!ref || !Number.isInteger(ref.line) || ref.line < 1 || !small(ref.reason, 300)) {
      throw new Error('Investigation requires path, positive line, and reason');
    }
    const file = pathIn(state.repo, ref.path);
    runGit(state.repo, ['ls-files', '--error-unmatch', '--', ref.path]);
    const count = readFileSync(file, 'utf8').split('\n').length;
    if (ref.line > count) throw new Error('Investigation line outside source file: ' + ref.path);
    return { path: ref.path, line: ref.line, reason: ref.reason };
  });
  return { summary: data.summary, files, risks: data.risks };
}

export function specialistInvocation(provider, role, model, prompt, outputPath) {
  if (!['explorer', 'checker'].includes(role)) throw new Error('Unknown specialist role');
  if (provider === 'claude') return {
    command: 'claude',
    args: ['-p', ...(model ? ['--model', model] : []), '--output-format', 'json',
      '--permission-mode', 'dontAsk', '--tools', 'Read,Grep,Glob',
      '--disallowedTools', 'Agent,mcp__*'],
    stdin: prompt,
  };
  if (provider === 'codex') return {
    command: 'codex',
    args: ['exec', ...(model ? ['-m', model] : []), '--sandbox', 'read-only',
      '-c', 'approval_policy="never"', '-c', 'agents.enabled=false', '--json',
      '--output-last-message', outputPath, '-'],
    stdin: prompt,
  };
  throw new Error('Unsupported specialist provider');
}

export function runSpecialist(state, cfg, role, feature, prompt, { execute = spawnSync } = {}) {
  const outputDir = join(state.directory, 'conductor', role);
  mkdirSync(outputDir, { recursive: true });
  const out = join(outputDir, feature.id + '-last-message.txt');
  const invocation = specialistInvocation(cfg.provider, role, cfg.specialists.models[role] ?? null, prompt, out);
  const result = execute(invocation.command, invocation.args, {
    cwd: role === 'checker' ? feature.worktree : state.repo,
    input: invocation.stdin, encoding: 'utf8', maxBuffer: MAX_OUTPUT,
    timeout: 120000, env: workerEnvironment(cfg.provider),
  });
  writeFileSync(join(outputDir, feature.id + '.jsonl'), result.stdout ?? '');
  if (result.error || result.status !== 0) throw new Error('Specialist ' + role + ' failed (' +
    (result.error?.message ?? result.status) + '); no fallback or retry attempted');
  let answer;
  if (cfg.provider === 'claude') {
    const envelope = JSON.parse(result.stdout);
    if (envelope.is_error || (envelope.subtype && envelope.subtype !== 'success') ||
        (Array.isArray(envelope.permission_denials) && envelope.permission_denials.length) ||
        typeof envelope.result !== 'string') throw new Error('Specialist response unsuccessful or denied');
    answer = envelope.result;
  } else {
    if (!existsSync(out)) throw new Error('Codex specialist output missing');
    answer = readFileSync(out, 'utf8');
  }
  let data;
  try { data = JSON.parse(answer); } catch { throw new Error('Specialist returned invalid JSON'); }
  return { data, provider: cfg.provider, model: cfg.specialists.models[role] ?? null,
    usage: extractUsage(cfg.provider, result.stdout ?? ''), at: new Date().toISOString() };
}

export function saveInvestigation(state, feature, result) {
  const data = validateInvestigation(result.data, state);
  const saved = { head: state.baseline, ...result, data };
  writeJson(location(state, 'investigations', feature.id), saved);
  return saved;
}

export function investigationContext(state, feature) {
  if (!state.conductor?.enabled) return '';
  const path = location(state, 'investigations', feature.id);
  if (!existsSync(path)) return '';
  const investigation = JSON.parse(readFileSync(path, 'utf8'));
  if (investigation.head !== state.baseline) return '';
  return '\nRead-only investigation (unverified; inspect referenced source yourself):\n' +
    JSON.stringify(investigation.data).slice(0, 3500) + '\n';
}

export function captureFeatureDiff(state, feature, maxChars) {
  if (!feature.startHead || !feature.head || !existsSync(feature.worktree)) throw new Error('Checker requires completed feature worktree and commit');
  const head = runGit(feature.worktree, ['rev-parse', 'HEAD']).trim();
  if (head !== feature.head) throw new Error('Feature HEAD changed before checker');
  const patch = runGit(feature.worktree, ['diff', '--no-ext-diff', '--no-textconv', '--unified=3',
    feature.startHead, feature.head, '--']);
  return { head, base: feature.startHead, sha256: digest(patch), chars: patch.length,
    truncated: patch.length > maxChars, patch: patch.slice(0, maxChars) };
}

export function runTargetedTests(state, feature, seconds, { execute = spawnSync } = {}) {
  const tests = validateTargetedTests(feature.targetedTests);
  const reports = [];
  // A conductor can itself be tested under node --test. Do not let Node's
  // recursive test-runner guard silently skip the explicitly requested tests.
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  delete environment.CONTEXT7_API_KEY;
  for (const [index, path] of tests.entries()) {
    pathIn(feature.worktree, path);
    const output = join(state.directory, 'conductor', 'tests', feature.id, feature.head, String(index + 1) + '.log');
    mkdirSync(dirname(output), { recursive: true });
    const result = execute(process.execPath, ['--test', path], {
      cwd: feature.worktree, encoding: 'utf8', timeout: seconds * 1000, maxBuffer: 1024 * 1024,
      shell: false, env: environment,
    });
    const log = 'Command: node --test ' + path + '\nCommit: ' + feature.head + '\nExit: ' +
      String(result.status) + '\nError: ' + String(result.error?.message ?? 'none') + '\n' +
      String(result.stdout ?? '') + '\n' + String(result.stderr ?? '');
    writeFileSync(output, log);
    reports.push({ path, status: result.error || result.status !== 0 ? 'failed' : 'passed',
      exitCode: result.status, log: relative(state.directory, output), sha256: digest(log), head: feature.head });
  }
  return reports;
}

export function checkerPrompt(feature, diff, tests, dependencyContext = '') {
  return [
    'You are an independent read-only patch checker. Inspect callers using Read/Grep/Glob only; no edits, shell commands, subagents, or provider handoffs.',
    'You are given the ACTUAL git diff for the recorded commit. Review changed callers, likely regressions, and acceptance gaps.',
    'Tests are deterministic local results, not model assertions. Missing tests are not passes.',
    'Never approve the acceptance ledger, integration, or publishing.',
    'Return ONLY JSON: {"verdict":"pass|fail|needs-human","summary":"short","findings":[{"path":"relative changed file or verified caller","line":1,"severity":"high|medium|low","detail":"short"}]}.',
    'Feature:', JSON.stringify({ id: feature.id, head: feature.head, acceptance: feature.acceptance,
      interfaces: feature.interfaces, runtimeRequired: feature.runtimeRequired }),
    'Diff metadata:', JSON.stringify({ head: diff.head, base: diff.base, sha256: diff.sha256,
      chars: diff.chars, truncated: diff.truncated }),
    'Targeted test results:', JSON.stringify(tests),
    'Actual diff:\n' + diff.patch,
    ...(dependencyContext ? [dependencyContext] : []),
  ].join('\n\n');
}

export function validateChecker(data, diff, worktree = null) {
  if (!data || !['pass', 'fail', 'needs-human'].includes(data.verdict) ||
      !small(data.summary, 1500) || !Array.isArray(data.findings) || data.findings.length > 30) {
    throw new Error('Invalid checker report');
  }
  const paths = new Set([...diff.patch.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)].map(m => m[2]));
  const findings = data.findings.map(f => {
    if (!f || !safePath(f.path) || !Number.isInteger(f.line) || f.line < 1 ||
        !['high', 'medium', 'low'].includes(f.severity) || !small(f.detail, 500)) {
      throw new Error('Checker finding requires changed file or verified caller, positive line, severity, detail');
    }
    if (!paths.has(f.path)) {
      if (!worktree) throw new Error('Checker finding requires changed file or verified caller');
      const file = pathIn(worktree, f.path);
      runGit(worktree, ['ls-files', '--error-unmatch', '--', f.path]);
      if (f.line > readFileSync(file, 'utf8').split('\n').length) {
        throw new Error('Checker caller line outside source file');
      }
    }
    return { path: f.path, line: f.line, severity: f.severity, detail: f.detail };
  });
  if (diff.truncated && data.verdict === 'pass') throw new Error('Checker cannot pass a truncated diff');
  return { verdict: data.verdict, summary: data.summary, findings };
}

export function saveCheck(state, feature, diff, tests, result) {
  const data = validateChecker(result.data, diff, feature.worktree);
  const saved = { head: feature.head, diff: { sha256: diff.sha256, chars: diff.chars,
    truncated: diff.truncated }, tests, ...result, data,
    status: tests.some(t => t.status !== 'passed') ? 'failed-tests' : data.verdict };
  writeJson(location(state, 'checks', feature.id), saved);
  return saved;
}
