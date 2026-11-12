import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { backendName } from './backends.mjs';

const METRICS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
const number = value => Number.isFinite(value) && value >= 0 ? value : null;
const sum = (rows, key) => {
  const values = rows.map(row => row[key]).filter(value => value !== null && value !== undefined);
  return values.length ? values.reduce((a, b) => a + b, 0) : null;
};
const jsonEvents = raw => raw.split(/\r?\n/).flatMap(line => {
  try { const event = JSON.parse(line); return event && typeof event === 'object' ? [event] : []; }
  catch { return []; }
});
const empty = () => ({ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, cacheHitRatio: null });
const ratio = (a, b) => a !== null && b !== null && b > 0 ? Math.round(a / b * 10000) / 10000 : null;
function claudeUsage(events) {
  // Claude's final result is the aggregate; message events must not be summed again.
  const report = events.filter(event => event.type === 'result' && event.usage).at(-1);
  if (!report) return null;
  const u = report.usage;
  const input = number(u.input_tokens), read = number(u.cache_read_input_tokens), write = number(u.cache_creation_input_tokens);
  const total = input !== null && read !== null && write !== null ? input + read + write : null;
  return { inputTokens: total, outputTokens: number(u.output_tokens), cacheReadTokens: read,
    cacheWriteTokens: write, cacheHitRatio: ratio(read, total) };
}
function codexUsage(events) {
  // Prefer a cumulative total when the CLI provides it. Otherwise sum completed turns.
  const totals = events.map(event => event.info?.total_token_usage ?? event.total_token_usage).filter(Boolean);
  if (totals.length) {
    const u = totals.at(-1);
    const input = number(u.input_tokens), read = number(u.cached_input_tokens);
    return { inputTokens: input, outputTokens: number(u.output_tokens),
      cacheReadTokens: read, cacheWriteTokens: null, cacheHitRatio: ratio(read, input) };
  }
  const turns = events.filter(event => event.type === 'turn.completed' && event.usage).map(event => event.usage);
  if (!turns.length) return null;
  const input = sum(turns.map(u => ({ n: number(u.input_tokens) })), 'n');
  const read = sum(turns.map(u => ({ n: number(u.cached_input_tokens) })), 'n');
  return { inputTokens: input, outputTokens: sum(turns.map(u => ({ n: number(u.output_tokens) })), 'n'),
    cacheReadTokens: read, cacheWriteTokens: null, cacheHitRatio: ratio(read, input) };
}
function opencodeUsage(events) {
  // Count only step_finish events, not incremental message.updated snapshots.
  const steps = events.filter(e => e.type === 'step_finish').map(e => e.part ?? e.data?.part ?? e.properties?.part).filter(p => p?.tokens);
  if (!steps.length) return null;
  const u = steps.map(p => p.tokens);
  return { inputTokens: sum(u.map(x => ({ n: number(x.input) })), 'n'),
    outputTokens: sum(u.map(x => ({ n: number(x.output) })), 'n'),
    cacheReadTokens: sum(u.map(x => ({ n: number(x.cache?.read) })), 'n'),
    cacheWriteTokens: sum(u.map(x => ({ n: number(x.cache?.write) })), 'n'),
    // OpenCode's input/cache token accounting can differ by provider; don't invent a denominator.
    cacheHitRatio: null };
}
export function extractUsage(backend, raw) {
  backendName(backend);
  const events = jsonEvents(raw);
  const usage = backend === 'claude' ? claudeUsage(events)
    : backend === 'codex' ? codexUsage(events)
      : backend === 'opencode' ? opencodeUsage(events) : null;
  return usage ?? empty();
}
export function summarizeUsage(attempts) {
  const groups = [...new Set(attempts.map(a => a.backend))].map(backend => {
    const rows = attempts.filter(a => a.backend === backend);
    const known = rows.filter(a => METRICS.some(k => a.usage[k] !== null));
    const result = Object.fromEntries(METRICS.map(key => [key, sum(known.map(a => a.usage), key)]));
    const denom = backend === 'claude' || backend === 'codex' ? result.inputTokens : null;
    return { backend, attempts: rows.length, measuredAttempts: known.length, ...result,
      cacheHitRatio: ratio(result.cacheReadTokens, denom) };
  });
  return { groups, attempts };
}
export function readBatchUsage(state, { maxLogBytes = 16 * 1024 * 1024 } = {}) {
  const attempts = [];
  for (const feature of state.features) for (let attempt = 1; attempt <= (feature.attempt ?? 0); attempt++) {
    const path = join(state.directory, feature.id, String(attempt), 'worker.jsonl');
    const spec = join(state.directory, feature.id, String(attempt), 'spec.json');
    let backend = feature.backend ?? state.backend;
    if (existsSync(spec)) {
      try { const s = JSON.parse(readFileSync(spec, 'utf8')); backend = s.feature?.backend ?? s.state?.backend ?? backend; }
      catch { /* preserve unknown provenance rather than fail the whole report */ }
    }
    backend = backendName(backend);
    let usage = empty(), note = 'no worker log';
    if (existsSync(path)) {
      if (statSync(path).size > maxLogBytes) note = 'log too large; metrics unavailable';
      else {
        usage = extractUsage(backend, readFileSync(path, 'utf8'));
        note = METRICS.some(k => usage[k] !== null) ? 'reported' : 'CLI usage unavailable';
      }
    }
    attempts.push({ feature: feature.id, attempt, backend, model: feature.model ?? state.promptSettings?.workerModels?.[backend] ?? null,
      status: attempt === feature.attempt ? feature.status : 'previous attempt', usage, note });
  }
  return { batch: state.id, generatedAt: new Date().toISOString(), ...summarizeUsage(attempts),
    caveat: 'Metrics are parsed from local CLI logs; missing data is unknown, not zero. No subscription quota or billing balance is available.' };
}
const display = value => value === null || value === undefined ? 'n/a' : value.toLocaleString('en-US');
export function formatUsageReport(report) {
  const rows = [
    ['Provider', 'Attempts', 'Measured', 'Input', 'Output', 'Cache read', 'Cache write', 'Hit ratio'],
    ...report.groups.map(g => [g.backend, String(g.attempts), String(g.measuredAttempts), display(g.inputTokens),
      display(g.outputTokens), display(g.cacheReadTokens), display(g.cacheWriteTokens),
      g.cacheHitRatio === null ? 'n/a' : (g.cacheHitRatio * 100).toFixed(1) + '%']),
  ];
  const widths = rows[0].map((_, i) => Math.max(...rows.map(row => row[i].length)));
  return ['Batch: ' + report.batch, rows.map(row => row.map((value, i) => value.padEnd(widths[i])).join('  ')).join('\n'),
    '', ...report.attempts.filter(a => a.note !== 'reported').map(a => a.feature + ' #' + a.attempt + ' (' + a.backend + '): ' + a.note),
    '', report.caveat].join('\n');
}
