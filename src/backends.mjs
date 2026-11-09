// One CLI backend per batch. Do not run mixed provider workers in the same batch.
export const BACKENDS = Object.freeze(['codex', 'claude', 'opencode']);
export function backendName(value = 'codex') {
  if (!BACKENDS.includes(value)) throw new Error(`Unsupported agent backend: ${value}. Choose codex, claude or opencode.`);
  return value;
}
export function backendRole(value = 'codex') {
  return {
    codex: '.codex/agents/feature_engineer.toml',
    claude: '.claude/agents/feature-engineer.md',
    opencode: '.opencode/agents/feature-engineer.md',
  }[backendName(value)];
}
const CLAUDE_TOOLS = [
  'Read', 'Edit', 'Write', 'Glob', 'Grep',
  'Bash(git status *)', 'Bash(git diff *)', 'Bash(git log *)',
  'Bash(git show *)', 'Bash(git add *)', 'Bash(git commit *)',
  'Bash(git ls-files *)', 'Bash(npm run typecheck)',
  'Bash(npm test)', 'Bash(npm run build)', 'Bash(npm run generator:report)',
  'Bash(rg *)', 'Bash(ls *)',
];
export function workerInvocation(value, feature, common, prompt) {
  const backend = backendName(value);
  if (backend === 'codex') return {
    command: 'codex',
    args: ['exec', '--strict-config', '--sandbox', 'workspace-write', '-c', 'approval_policy="never"', '-c', 'agents.enabled=false',
      '--add-dir', common, '--cd', feature.worktree, '--json',
      '--output-last-message', `${feature.attemptDirectory}/summary.md`, '-'],
    stdin: prompt,
  };
  if (backend === 'claude') return {
    command: 'claude',
    args: ['-p', '--agent', 'feature-engineer', '--output-format', 'json', '--permission-mode', 'dontAsk',
      '--allowedTools', ...CLAUDE_TOOLS, '--disallowedTools', 'mcp__*'],
    stdin: prompt,
  };
  // OpenCode agent grants only listed commands. Do not use --auto.
  return {
    command: 'opencode',
    args: ['run', '--agent', 'feature-engineer', '--format', 'json', prompt],
    stdin: '',
  };
}
/** An independent Claude worker should not inherit its coordinator's session markers. */
export function workerEnvironment(value, source = process.env) {
  const environment = { ...source };
  if (backendName(value) === 'claude') {
    delete environment.CLAUDECODE;
    delete environment.CLAUDE_CODE_ENTRYPOINT;
  }
  return environment;
}
export function preflightFor(value) {
  const backend = backendName(value);
  if (backend === 'codex') return [
    { command: 'codex', args: ['--strict-config', '-s', 'workspace-write', '-a', 'never', '-c', 'agents.enabled=false', 'app-server', '--print-startup-config'] },
    { command: 'codex', args: ['sandbox', '-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"', '--', '/bin/true'] },
  ];
  return [{ command: backend, args: ['--version'] }, { command: backend, args: ['--help'] }];
}
export function parseWorkerResult(value, raw) {
  const backend = backendName(value);
  if (backend === 'codex') throw new Error('Codex writes summary.md directly');
  const parsed = raw.trim().split(/\r?\n/).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  if (backend === 'claude') {
    const report = parsed.findLast(e => e.type === 'result') ?? parsed.at(-1);
    if (!report || report.is_error || (report.subtype && report.subtype !== 'success') ||
        (Array.isArray(report.permission_denials) && report.permission_denials.length)) {
      throw new Error('Claude result missing, unsuccessful or denied permissions; inspect worker.jsonl');
    }
    if (typeof report.result !== 'string' || !report.result.trim()) throw new Error('Claude returned an empty report');
    return report.result;
  }
  if (parsed.some(e => e.type === 'error')) throw new Error('OpenCode event stream reported an error');
  const texts = parsed.map(e => e.part?.text ?? e.data?.part?.text ?? e.properties?.part?.text ?? (e.type === 'text' ? e.text : undefined))
    .filter(value => typeof value === 'string' && value.trim());
  if (!texts.length) throw new Error('OpenCode returned no text report; inspect worker.jsonl');
  return texts.join('\n');
}
