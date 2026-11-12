# Architecture

The kit has three parts: a project-aware installer, a diagnostic command, and a durable Git-worktree orchestrator.

- `src/install.mjs` installs agent instructions and the runner without replacing unmanaged instructions.
- `src/doctor.mjs` reports SDK/package capabilities without changing them.
- `src/orchestrator.mjs` plans, schedules, collects, reviews and integrates independent feature workers.
- `src/backends.mjs` selects Codex, Claude Code, OpenCode or Muse Code. A strict project policy
  allows only the configured provider by default and checks any detected active coordinator.

Batch state and logs live under Git's common directory. Feature branches and worktrees are isolated; shared XR/browser sessions must be serialized. Integration requires review evidence and existing project validation scripts. Publication requires an explicit approval and opens a PR rather than merging it.

The toolkit does not prescribe a particular IWSDK Create preset or gameplay architecture. Inspect installed SDK types and project configuration before using unfamiliar APIs.

Shared context is stored in project AGENT_CONTEXT.md. The coordinator creates per-feature checkpoint snapshots under Git's common directory, and can explicitly reassign a stopped feature to a different CLI after reviewing partial work. It never automatically retries on a quota error.

The provider-isolation guard in `src/provider-policy.mjs` validates the effective backend at plan, start, retry and handoff. Start checks are mandatory even for legacy batches. Cross-provider overrides must name the target backend and be supplied again for every start. The kit cannot block direct CLI calls outside its runner.

## Token efficiency (v0.4)

The worker prompt is assembled by `src/prompt.mjs` with a stable role/project prefix and dynamic feature/checkpoint details at the end. `src/handoff.mjs` preserves the full checkpoint and writes a separate bounded `.compact.md` prompt summary. The configured context budgets are character caps, not model-token budgets. Optional model pins are snapshotted at planning and passed to supported CLI invocations; provider isolation still applies.

`src/usage.mjs` reads local worker logs and reports only metrics explicitly emitted by each CLI. `src/cache-audit.mjs` scans known Claude configuration locations read-only, and `src/review.mjs` exports a separate review prompt without starting a provider. See [token efficiency](token-efficiency.md).
