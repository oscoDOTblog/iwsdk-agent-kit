# Provider isolation (Codex / Claude Code / OpenCode / Muse)

The kit runs **only the project's configured CLI backend by default**.
It never automatically spends another provider's allowance when the selected
worker fails or hits a quota. This policy is enforced when planning a batch,
starting or resuming it, retrying a stopped feature, and handing a feature
to another backend.

## Configure the intended provider

In each IWSDK project, edit `iwsdk-agent-kit.config.json`:

```json
{
  "version": 2,
  "backend": "codex",
  "providerIsolation": "strict"
}
```

Keep your existing `baseBranch`, `maxConcurrency` and other config keys.
The installer does **not** replace existing configuration. Older configs
without `providerIsolation` also enforce strict isolation.

Set `backend` to `claude`, `opencode` or `muse` when you deliberately
want that provider's workers by default. This setting governs the **kit's
worker launcher**, not the model in your interactive chat session.

When available, the kit additionally checks known coordinator environment
markers: `CODEX_THREAD_ID` for Codex and `CLAUDECODE` for Claude Code.
You can explicitly identify the active coordinator with
`IWSDK_AGENT_COORDINATOR=opencode` (or `muse`, `codex`, `claude`).
If detection and project configuration disagree, a run is blocked unless
explicitly overridden. Detection is best-effort; **the project config is the
authoritative fallback**, especially for OpenCode and Muse.

```bash
npx iwsdk-agent-kit doctor
npm run agents:plan -- features.json
npm run agents:start -- my-batch --approve
```

A batch with no backend inherits the project setting. A batch JSON file,
`--backend` flag, or feature-level `backend` cannot silently select a
different provider. The runner also checks again at `start` so **old batches
created before this policy are blocked** if they would use the wrong CLI.

## Optional harness-following backend

Set `"backend": "auto"` to intentionally use the CLI that is coordinating
the batch. This is an **opt-in** setting, not cross-provider fallback:

| Coordinator | Detection |
| --- | --- |
| Codex | `CODEX_THREAD_ID` |
| Claude Code | `CLAUDECODE` |
| OpenCode | `IWSDK_AGENT_COORDINATOR=opencode` |
| Muse | `IWSDK_AGENT_COORDINATOR=muse` |

An explicit `IWSDK_AGENT_COORDINATOR=codex|claude|opencode|muse` is also
supported. Conflicting known markers or missing detection fail closed. The
coordinator marker is a **caller assertion**, not an authentication mechanism.

The resolved backend is stored when planning a batch; a later start from a
different CLI is blocked by strict isolation unless the user explicitly
authorizes that provider for that command. `conductor.provider: "auto"`
also works for optional AI planner/verifier roles, but those roles currently
support only Claude and Codex. Disable `aiPlanning` and `aiVerification`
for OpenCode/Muse workers.

## Upgrade safety

`init` records the SHA-256 of each installed managed script in
`.iwsdk-agent-kit.manifest.json`. An update may replace only an unchanged
manifest-tracked script automatically (after backing it up). Customized or
pre-manifest scripts are preserved and reported as conflicts. A conflict aborts the managed-script update before any runner or package files are changed. Review
`init --dry-run` before `init --force-managed`; forcing explicitly replaces
the affected scripts and creates content-hash backups. Existing configuration
and custom agent files remain preserved.

## Deliberate cross-provider execution

If you explicitly authorize using Muse workers while Codex is the project
default, name Muse on **both** commands:

```bash
npm run agents:plan -- features.json --backend muse \
  --allow-cross-provider muse --approve

npm run agents:start -- my-batch --approve \
  --allow-cross-provider muse
```

Authorization at planning is **not inherited** by a later start. Each start
requires its own explicit target-specific override. For a batch with multiple
nondefault backends, name each provider separately with repeated
`--allow-cross-provider BACKEND` flags.

After a quota failure, preserve the stopped worker's worktree, inspect its
checkpoint and commit reviewed partial changes before an intentional handoff:

```bash
npm run agents:handoff -- my-batch my-feature --backend muse \
  --allow-cross-provider muse --approve

npm run agents:start -- my-batch --approve \
  --allow-cross-provider muse
```

No provider is switched automatically. No authorization is stored as a
permanent global exemption. The batch state records the provider and the
explicit override used when planning, starting, or handing off.

## Existing projects and stale context

```bash
npm install --save-dev "github:oscoDOTblog/iwsdk-agent-kit#main"
npx iwsdk-agent-kit init --dry-run
npx iwsdk-agent-kit init
npx iwsdk-agent-kit doctor
```

Review the changed runner files and commit them. The installer preserves
existing `iwsdk-agent-kit.config.json` and `AGENT_CONTEXT.md`.
If your context still says **"Claude is the chosen backend"** while your
project config says `"backend": "codex"`, edit the stale sentence yourself.
Project history belongs in shared context; **provider selection belongs in
the config**, not a free-form Markdown instruction.

## Scope of the protection

This is a **guardrail in the IWSDK Agent Kit runner**, not an operating-system
security boundary. It does not control direct shell invocations such as
`claude -p` made outside the kit, nor can it prove that an interactive agent
did not add override flags without human approval. Treat cross-provider
override flags as user-authorized actions; do not instruct agents to add them
on their own. For a hard boundary, remove unwanted provider CLIs or credentials
from the coordinator's execution environment.

The kit cannot read actual subscription usage or provider billing. It only
controls which CLI executable its workers launch.
