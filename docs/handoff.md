# Cross-harness context and safe handoff

IWSDK Agent Kit supports **Codex, Claude Code, OpenCode, and Meta Muse Code**.
The configured backend in `iwsdk-agent-kit.config.json` is the default and
is enforced at plan, start, retry and handoff. A stopped feature can be
explicitly handed to a different backend using a named, per-command override. The kit does **not** automatically rerun a task
when a provider reaches its quota.

## Install / upgrade in an existing project

```bash
npm install --save-dev "github:oscoDOTblog/iwsdk-agent-kit#main"
npx iwsdk-agent-kit doctor
npx iwsdk-agent-kit init --dry-run
npx iwsdk-agent-kit init
```

The installer preserves unrelated project instructions and existing custom
agent definitions. It backs up changed managed files to
`.iwsdk-agent-kit-backups/` (ignored by Git). Review conflicts and backups,
then commit the intended project changes. A nonzero exit code 2 means existing
unmanaged files were preserved; it is not permission to overwrite them.

Muse Code is installed **separately** from this kit:

```bash
curl -fsSL https://dev.meta.ai/install.sh | sh
muse --version
muse  # one-time interactive sign-in
```

Meta's documentation: https://dev.meta.ai/docs/muse-code and
https://dev.meta.ai/docs/muse-code/extending

Other backends require their own installed and authenticated CLIs.

## Shared project context

The installer creates `AGENT_CONTEXT.md` only when it does not exist.
Treat it as a concise, **version-controlled**, human-reviewed source of truth:
project goal, architecture, SDK capabilities, decisions, status, verification,
and next actions. The installer adds references to it in `AGENTS.md` and
`CLAUDE.md`; agent role instructions also refer to it.

The runner includes this shared context in each worker prompt. It is not a
provider session transcript and does not transfer hidden reasoning, tool
permissions, credentials, or exact model state between providers.

**Only the coordinator should update AGENT_CONTEXT.md between batches.**
Workers must not edit it concurrently. Never put secrets or private data in
this file; it will usually be committed to Git.

## Task checkpoints

The coordinator writes per-feature snapshots at receipt of completion/failure,
periodically (approximately every 60 seconds) while work is running, and on
explicit request:

```bash
npm run agents:checkpoint -- example-batch
npm run agents:checkpoint -- example-batch pickup
```

They live in Git's common directory:

```text
.git/agent-workflow/batches/example-batch/handoffs/pickup.md
```

They include assignment, backend, status, baseline/current commit, owned
paths, acceptance criteria, current Git status, last error, and any final
agent summary. They are **local** and not automatically committed or synced
to another machine. A periodic snapshot cannot guarantee the model's
unwritten internal progress; Git and agent reports remain the source of
verifiable state.

## Handoff when usage is exhausted

If a worker stops due to a quota, rate limit, authentication issue, or other
failure, the coordinator keeps its worktree and logs. Failure classification
is advisory; log text is not proof of a specific provider limit.

1. Inspect `npm run agents:status -- example-batch`, the checkpoint, logs,
   and Git diff in the feature worktree.
2. If the worktree contains uncommitted partial changes, **review and commit**
   them on the feature branch. Do not reset or delete them.
3. Reassign the stopped feature to an installed/authenticated backend:

```bash
npm run agents:handoff -- example-batch pickup --backend muse --allow-cross-provider muse --approve
npm run agents:start -- example-batch --allow-cross-provider muse --approve
```

Other targets: `codex`, `claude`, `opencode`. The next worker gets the
same assignment, shared project context, and the previous checkpoint.
The coordinator refuses a handoff while the worker is still alive or its
worktree is dirty. Provider isolation also blocks an unauthorized cross-provider
handoff and blocks `start` if the override is omitted. See
[provider isolation](provider-isolation.md) for config and examples. It does not duplicate a running agent or automatically
increase spend on another provider.

**Why not auto-failover by default?** CLI quota messages and exit codes differ;
a model may have partially edited files or committed code before failing.
Blind retries can duplicate changes, consume credits, or damage work. A future
opt-in policy could automate only validated, clean-worktree quota cases.

## Muse's own subagents

Muse Code supports native subagents and custom agent definitions; the kit
installs a project-level Muse role under `.agents/agents/`. The **kit's
worker runs are intentionally single-task**, because the kit itself already
allocates isolated Git worktrees and owns concurrency and integration gates.
Avoid nested worktree coordinators. Muse's native workflows can still be used
independently in interactive sessions where appropriate.

Muse headless execution uses `muse exec --disable-approval` with its OS
sandbox **enabled**. The kit never uses `--yolo`. A zero exit code alone
does not prove the feature works; the coordinator still requires commits,
review, and project tests.

## Compact context for worker restarts (v0.4)

The original full handoff `handoffs/<feature>.md` is preserved. The coordinator also writes `handoffs/<feature>.compact.md` with a bounded factual summary for the next worker prompt. It includes only explicit decisions, known file paths, Git state, last error and a clearly unverified agent report. Old batches without a compact checkpoint still work with a truncated full handoff. See [token efficiency](token-efficiency.md).
