# IWSDK Agent Kit

A reusable, project-aware multi-agent development workflow for Meta IWSDK projects. Run **Codex**, **Claude Code**, **OpenCode**, or **Meta Muse Code** independently. Feature workers use isolated Git worktrees, with explicit review and integration gates.

> **Experimental v0.6.0** — public GitHub-source package, not published to npm. The four CLI adapters are tested with local mock data only; authenticated model workers and Quest runtime testing have not been verified.

## Install into an existing IWSDK project

```bash
cd /path/to/your-iwsdk-project
npm install --save-dev "github:oscoDOTblog/iwsdk-agent-kit#main"
npx iwsdk-agent-kit doctor
npx iwsdk-agent-kit init --dry-run
npx iwsdk-agent-kit init
```

The installer copies the runner into `scripts/`, installs project-local agent definitions, and merges a clearly delimited managed section into `AGENTS.md` and `CLAUDE.md`. It also creates `AGENT_CONTEXT.md` if missing. Existing unmanaged agent files are preserved and reported as conflicts. It adds `agents:*` scripts to `package.json`. Changed managed files are backed up to `.iwsdk-agent-kit-backups/` before being updated.

**Provider isolation is now strict by default.** The kit uses the `backend` from your project's `iwsdk-agent-kit.config.json` (normally `codex`) and blocks unexpected Claude/OpenCode/Muse workers at **plan and start**, including existing batches. To switch your default, edit that config; for a one-off cross-provider run, explicitly authorize the named backend at both steps. See [provider isolation](docs/provider-isolation.md).

**Already using the kit?** Re-run the install command to update the GitHub dependency, then inspect `npx iwsdk-agent-kit init --dry-run`. The installer overwrites managed runner scripts after backing them up; **do not run `init` blindly in a project with custom worker/sandbox code**. Review the diff and commit only the intended changes.

## Use one coding CLI per batch

Copy [examples/feature-batch.json](examples/feature-batch.json) to your project, then edit the feature assignments and acceptance criteria.

```bash
npm run agents:plan -- features.json --backend codex
npm run agents:status -- example-batch
npm run agents:start -- example-batch --approve
npm run agents:collect -- example-batch
# Review changes and approve the generated review.json evidence.
npm run agents:integrate -- example-batch --approve
npm run agents:publish -- example-batch --approve
```

To use `claude`, `opencode` or `muse` by default, first change `backend` in `iwsdk-agent-kit.config.json` to that provider. An unexpected provider is blocked unless the command includes `--allow-cross-provider BACKEND --approve`. The batch has a default backend, but an explicitly reviewed handoff can reassign a **stopped** feature to another CLI. Running `publish` pushes an integration branch and creates a PR; it never merges the PR.

## Optional Conductor Mode (v0.5)

The existing manual worktree workflow remains the default. **Conductor Mode
is disabled unless explicitly enabled in the project config and invoked
with `--approve`.** It uses the same worker runner, worktrees, provider
isolation, checkpoints, and manual integration/publishing gates.

```bash
npm run agents:plan -- features.json
npm run agents:conduct -- my-batch --approve
npm run agents:conduct-status -- my-batch
npm run agents:evidence -- my-batch
```

- Optional read-only Claude/Codex planner prioritizes **already approved**
  feature tasks; it cannot expand scope or change dependency rules.
- Existing worker model pins still select implementers; separate planner
  and verifier model pins are supported.
- Deterministic scheduling respects bounded concurrency, total worker
  launches, narrowly scoped transient retries, and per-invocation
  scheduling time. Detached workers are not killed when the supervisor pauses.
- A commit-bound acceptance ledger requires independently reviewed
  artifacts before conductor batches can be collected or integrated.
- Resume the same batch without restarting completed workers.
- **No automatic provider switching, auto-integration, auto-publishing, or
  hard monetary spending cap.** Model-based verification is advisory only.

See the [Conductor Mode guide](docs/conductor.md) for configuration,
safety limitations, evidence commands, and upgrade instructions.

## Optional Specialist Workers (v0.6)

An additional opt-in layer for Conductor Mode separates read-only code
exploration, isolated feature implementation, and independent diff review.
It can run explicitly listed Node test files after completed patches, retain
commit-bound test logs, and report token usage by role. All specialist
profiles default to disabled. Existing provider isolation, manual acceptance
evidence, and publishing gates remain unchanged.

See the [Specialist Workers guide](docs/specialists.md) for configuration,
test-file allowlisting, model restrictions, call limits and limitations.

## Token efficiency and usage reporting (v0.4)

New optional commands work without launching an AI worker:

```bash
npm run agents:usage -- example-batch
npm run agents:usage -- example-batch --json
npm run agents:cache-audit
npm run agents:review-prompt -- example-batch pickup
```

- **Usage:** parses locally reported token/cache metrics per provider and feature attempt. Unknown data remains `n/a`; it cannot read subscription quotas or billable cost.
- **Cache-friendly prompts:** stable role/project prefix, dynamic task details last, bounded project context and compact checkpoints.
- **Model pinning:** optionally set `workerModels` for Codex, Claude or OpenCode in `iwsdk-agent-kit.config.json`. Models are snapshotted at planning and fixed for each attempt; Muse pins are not yet supported.
- **Read-only cache audit:** identifies potential Claude settings/skill/MCP cache breakers without changing permissions or revealing endpoint values.
- **Isolated review prompts:** generates a separate, bounded review assignment for you to run in a new CLI session. It does not launch another provider or replace the normal review gates.

See the [token efficiency guide](docs/token-efficiency.md) for configuration, limitations and examples.

## Muse Code and quota handoffs

Install Muse Code separately (macOS/Linux) and sign in once:

```bash
curl -fsSL https://dev.meta.ai/install.sh | sh
muse --version
muse
```

Set `"backend": "muse"` in the project config to use Muse by default. Alternatively, for a **one-off authorized** Muse batch from a Codex-configured project:

```bash
npm run agents:plan -- features.json --backend muse --allow-cross-provider muse --approve
npm run agents:start -- example-batch --allow-cross-provider muse --approve
```

If Codex/Claude/OpenCode/Muse stops due to a usage limit, **there is no automatic failover**. Inspect the worker's checkpoint and any partial changes, commit reviewed partial work, then explicitly switch the stopped feature:

```bash
npm run agents:checkpoint -- example-batch pickup
npm run agents:handoff -- example-batch pickup --backend muse --allow-cross-provider muse --approve
npm run agents:start -- example-batch --allow-cross-provider muse --approve
```

The kit maintains a version-controlled `AGENT_CONTEXT.md` for project facts and local per-feature checkpoints in Git's common directory. Each worker receives both in its prompt. Active work gets best-effort Git-state snapshots roughly every 60 seconds; hidden model state is not transferred.

See [handoff and upgrade guide](docs/handoff.md) and [provider isolation policy](docs/provider-isolation.md) for details and safety requirements.

## Different IWSDK presets

`doctor` inspects the installed SDK dependency, `iwsdk.config.json` when present, available scripts, TypeScript setup and Git state. It does **not** enable or disable locomotion, grabbing, physics or any other IWSDK feature. Unknown settings remain unknown. The installer selects an existing `dev`, `main` or `master` branch as its default, and the runner validates only checks defined by your project.

## Important limitations

- A clean, committed Git baseline and an existing package.json are needed.
- Feature workers currently require a package-lock.json and `npm ci`; this may run dependency lifecycle scripts.
- Worktrees isolate source files, not XR hardware, browsers, credentials or cloud services.
- Permission allowlists are not operating-system security boundaries.
- The workflow requires Linux, macOS or WSL; native Windows is not tested.
- The installer does not overwrite existing agent definition files; review reported conflicts. It backs up changed managed scripts and instructions.
- The package is not yet an npm registry release and the toolkit has not been tested with authenticated live AI workers, including Muse.
- Token parsing and cache audit behavior are best-effort and CLI-version-dependent; unknown metrics are not evidence of zero usage.

See [security](docs/security.md) and [architecture](docs/architecture.md). MIT licensed.
