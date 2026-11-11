# IWSDK Agent Kit

A reusable, project-aware multi-agent development workflow for Meta IWSDK projects. Run **Codex**, **Claude Code**, **OpenCode**, or **Meta Muse Code** independently. Feature workers use isolated Git worktrees, with explicit review and integration gates.

> **Experimental v0.3.0** — public GitHub-source package, not published to npm. The four CLI adapters are tested with local mock data only; authenticated model workers and Quest runtime testing have not been verified.

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

**Already using the kit?** Re-run the same install command above to update the GitHub dependency, then run `npx iwsdk-agent-kit init --dry-run` and `npx iwsdk-agent-kit init` to install the updated scripts and Muse role. Review conflicts and commit the intended changes.

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

See [security](docs/security.md) and [architecture](docs/architecture.md). MIT licensed.
