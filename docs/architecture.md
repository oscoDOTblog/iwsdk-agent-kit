# Architecture

The kit has three parts: a project-aware installer, a diagnostic command, and a durable Git-worktree orchestrator.

- `src/install.mjs` installs agent instructions and the runner without replacing unmanaged instructions.
- `src/doctor.mjs` reports SDK/package capabilities without changing them.
- `src/orchestrator.mjs` plans, schedules, collects, reviews and integrates independent feature workers.
- `src/backends.mjs` selects one coding CLI per batch: Codex, Claude Code or OpenCode.

Batch state and logs live under Git's common directory. Feature branches and worktrees are isolated; shared XR/browser sessions must be serialized. Integration requires review evidence and existing project validation scripts. Publication requires an explicit approval and opens a PR rather than merging it.

The toolkit does not prescribe a particular IWSDK Create preset or gameplay architecture. Inspect installed SDK types and project configuration before using unfamiliar APIs.
