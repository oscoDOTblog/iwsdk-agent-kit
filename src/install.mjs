import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectProject } from './doctor.mjs';
const kitRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const managedStart = '<!-- iwsdk-agent-kit:start -->';
const managedEnd = '<!-- iwsdk-agent-kit:end -->';
const guidance = `Use the IWSDK project's installed SDK version and inspect its config before implementing features.
Follow existing architecture; never assume grabbing, locomotion or physics is enabled.
For independent features, plan isolated Git worktrees through the installed agent runner.
Provider isolation is strict by default: use the backend in iwsdk-agent-kit.config.json
for feature workers. If the active coordinator is detected, it must also match.
Never silently invoke another provider CLI, including from a Codex or Claude session.
Cross-provider plan/start/handoff needs user authorization naming the target provider
and explicit --allow-cross-provider BACKEND --approve on EACH affected command.
Do not add these flags without the user's approval. A worker must not start other agents.
Read AGENT_CONTEXT.md before work and the coordinator's task checkpoint when resuming.
Only the coordinator updates AGENT_CONTEXT.md between batches; workers must not race to edit it.
Keep shared XR/browser/headset sessions exclusive to one worker.
Do not invent SDK APIs, overwrite unrelated work, or claim unexecuted tests.
Do not push, merge or deploy without explicit approval.`;
function mergeSection(original, body) {
  const section = `${managedStart}\n${body}\n${managedEnd}`;
  if (!original.includes(managedStart) && !original.includes(managedEnd)) return original.trimEnd() + (original.trim() ? '\n\n' : '') + section + '\n';
  const start = original.indexOf(managedStart), end = original.indexOf(managedEnd);
  if (start < 0 || end < start || original.indexOf(managedStart, start + 1) >= 0) throw Error('Malformed managed instruction section');
  return original.slice(0, start) + section + original.slice(end + managedEnd.length);
}
export function install(root = process.cwd(), { dryRun = false } = {}) {
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) throw Error('Run inside a project with package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const detected = inspectProject(root);
  const actions = [];
  const write = (path, content, mode = 'managed') => {
    if (existsSync(path)) {
      const previous = readFileSync(path, 'utf8');
      if (previous === content) { actions.push({path,action:'unchanged'}); return; }
      if (mode === 'new-only') { actions.push({path,action:'conflict',reason:'Existing unmanaged file preserved'}); return; }
    }
    if (existsSync(path) && mode === 'managed') {
      const previous = readFileSync(path, 'utf8');
      const hash = createHash('sha256').update(previous).digest('hex').slice(0, 12);
      const backup = join(root, '.iwsdk-agent-kit-backups', relative(root, path) + '.' + hash + '.bak');
      actions.push({path,action:'backup',backup});
      if (!dryRun && !existsSync(backup)) {
        mkdirSync(dirname(backup), {recursive:true});
        writeFileSync(backup, previous);
      }
    }
    actions.push({path,action:existsSync(path)?'update':'create'});
    if (!dryRun) { mkdirSync(dirname(path), {recursive:true}); writeFileSync(path,content); }
  };
  for (const [from,to] of [
    ['src/orchestrator.mjs','scripts/agents.mjs'],
    ['src/backends.mjs','scripts/backends.mjs'],
    ['src/handoff.mjs','scripts/handoff.mjs'],
    ['src/provider-policy.mjs','scripts/provider-policy.mjs'],
    ['src/prompt.mjs','scripts/prompt.mjs'],
    ['src/usage.mjs','scripts/usage.mjs'],
    ['src/review.mjs','scripts/review.mjs'],
    ['src/cache-audit.mjs','scripts/cache-audit.mjs'],
    ['templates/.codex/agents/feature_engineer.toml','.codex/agents/feature_engineer.toml'],
    ['templates/.claude/agents/feature-engineer.md','.claude/agents/feature-engineer.md'],
    ['templates/.opencode/agents/feature-engineer.md','.opencode/agents/feature-engineer.md'],
    ['templates/.agents/agents/feature-engineer.md','.agents/agents/feature-engineer.md']
  ]) {
    const dest = join(root,to), source = join(kitRoot,from);
    const text = readFileSync(source,'utf8').replace("'./backends.mjs'","'./backends.mjs'");
    // Never overwrite preexisting user agent files.
    write(dest,text,to.startsWith('scripts/')?'managed':'new-only');
  }
  const contextPath = join(root, 'AGENT_CONTEXT.md');
  write(contextPath, readFileSync(join(kitRoot, 'templates/AGENT_CONTEXT.md'), 'utf8'), 'new-only');
  const ignorePath = join(root, '.gitignore');
  const ignore = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : '';
  if (!ignore.split(/\r?\n/).includes('.iwsdk-agent-kit-backups/')) {
    write(ignorePath, ignore.trimEnd() + (ignore.trim() ? '\n' : '') + '.iwsdk-agent-kit-backups/\n');
  }
  for (const name of ['AGENTS.md','CLAUDE.md']) {
    const path=join(root,name);
    try { write(path,mergeSection(existsSync(path)?readFileSync(path,'utf8'):'',guidance)); }
    catch(e){ actions.push({path,action:'conflict',reason:e.message}); }
  }
  const base = detected.git ? (()=> {
    for(const b of ['dev','main','master']) {
      const r = importGit(root,b); if(r) return b;
    }
    return 'main';
  })() : 'main';
  const config=join(root,'iwsdk-agent-kit.config.json');
  write(config,JSON.stringify({version:2,baseBranch:base,backend:'codex',providerIsolation:'strict',maxConcurrency:2,detectedSDK:detected.sdk},null,2)+'\n','new-only');
  const scripts={plan:'node scripts/agents.mjs plan',start:'node scripts/agents.mjs start',status:'node scripts/agents.mjs status',usage:'node scripts/agents.mjs usage','cache-audit':'node scripts/cache-audit.mjs','review-prompt':'node scripts/agents.mjs review-prompt',checkpoint:'node scripts/agents.mjs checkpoint',handoff:'node scripts/agents.mjs handoff',retry:'node scripts/agents.mjs retry',collect:'node scripts/agents.mjs collect',integrate:'node scripts/agents.mjs integrate',publish:'node scripts/agents.mjs publish',cleanup:'node scripts/agents.mjs cleanup'};
  pkg.scripts ??= {};
  for(const [key,value] of Object.entries(scripts)) {
    const name='agents:'+key;
    if(pkg.scripts[name] && pkg.scripts[name]!==value) {actions.push({path:pkgPath,action:'conflict',reason:'Existing script '+name});continue;}
    pkg.scripts[name]=value;
  }
  write(pkgPath,JSON.stringify(pkg,null,2)+'\n');
  return actions;
}
import { spawnSync } from 'node:child_process';
function importGit(cwd,branch) {
  const result=spawnSync('git',['show-ref','--verify','--quiet','refs/heads/'+branch],{cwd});
  return result.status===0;
}
