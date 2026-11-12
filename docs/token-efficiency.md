# Token efficiency and observability (v0.4)

This toolkit cannot read your subscription quota or infer actual billing.
It can inspect **local worker logs** for token and cache fields explicitly
reported by a CLI. Missing fields are displayed as **n/a**, never zero.

## 1. Usage by batch and feature

After running a feature batch:

~~~bash
npm run agents:usage -- my-batch
npm run agents:usage -- my-batch --json
# or directly through the package:
npx iwsdk-agent-kit batch usage my-batch --json
~~~

The output groups attempts by backend, and JSON includes each feature/attempt,
provider, status, optional pinned model and token metrics. The original
worker logs remain local in Git's common directory.

- **Claude Code**: use the final result's aggregate usage. Total input is
  uncached input + cache read + cache creation tokens when all are reported.
  Do not sum intermediate assistant messages again.
- **Codex**: prefer the most recent cumulative token usage if provided;
  otherwise sum completed-turn usage. Cached input is a subset of input.
- **OpenCode**: sum step-finish token reports. Cache read/write values are
  reported when present, but no cache hit percentage is inferred because
  token accounting varies by provider.
- **Muse**: token metrics remain unavailable until a documented, tested
  machine-readable schema exists.

A missing log, unsupported CLI version, or partial worker failure may yield
unknown metrics. No token usage is invented and no model call is made by
the usage command. The CLI reports *tokens*, not USD or plan allowances.

## 2. Cache-friendly prompts and context budgets

Worker prompts are constructed in this order:

1. Stable agent role, safety/verification rules and project context
2. Dynamic feature assignment and baseline
3. Compact previous checkpoint

No per-attempt timestamps or feature IDs are inserted into the stable prefix.
This improves *opportunities* for cache reuse, but each worker is still an
independent CLI process; cross-process reuse is not guaranteed.

Optional project configuration in iwsdk-agent-kit.config.json:

~~~json
{
  "backend": "codex",
  "providerIsolation": "strict",
  "promptContextBudget": {
    "projectChars": 12000,
    "handoffChars": 3500
  }
}
~~~

Both budgets are character limits, not token counts, and accept values
from 500 to 16000. Project context remains in AGENT_CONTEXT.md; the runner
does not delete, rewrite or summarize the original file. Truncation markers
tell the worker to inspect the full source when needed.

## 3. Structured, compact handoffs

The coordinator continues writing the **full** checkpoint:

~~~text
.git/agent-workflow/batches/<batch>/handoffs/<feature>.md
~~~

It now also writes a bounded prompt-oriented summary:

~~~text
.git/agent-workflow/batches/<batch>/handoffs/<feature>.compact.md
~~~

The compact summary records the assignment, provider, branch, last known
commit, blockers, interfaces, owned paths, acceptance criteria, Git status,
unverified last worker report, and next inspection step. Confirmed decisions
are included only if explicitly supplied in the feature JSON:

~~~json
{
  "id": "toy",
  "description": "Implement a checkpoint toy",
  "decisions": ["Keep existing collision behavior"],
  "owns": ["src/toys/"],
  "acceptance": ["Toy can be reset"],
  "interfaces": "none",
  "contentChanges": false,
  "runtimeRequired": true
}
~~~

No hidden conversation or model state is transferred. The full checkpoint
and original logs remain available. Legacy batches with only a full
checkpoint are supported.

## 4. Optional model pins

Model selection is optional. With no pins, each CLI uses its own default.
To fix the model for the life of each worker attempt:

~~~json
{
  "workerModels": {
    "codex": "gpt-5.3-codex",
    "claude": "opus",
    "opencode": "provider/model"
  }
}
~~~

These values are **examples**, not promises that a model is available in
your account. Use a model identifier accepted by your installed CLI.

The config is validated and snapshotted at **plan**. Existing batches keep
their planned model selections even if the project config changes later.
Pins are passed as CLI arguments at worker launch: Codex -m, Claude --model,
OpenCode --model. The kit does not implement mid-attempt model switching.
Muse model selection is not yet verified and a Muse pin is rejected.

Provider isolation remains strict: model pinning does **not** grant permission
to use another provider.

## 5. Read-only Claude cache audit

~~~bash
npm run agents:cache-audit
npm run agents:cache-audit -- --json
npx iwsdk-agent-kit cache-audit --json
~~~

The audit checks user/project Claude settings, project .mcp.json, and
Markdown skills/commands under user and project .claude directories.
It flags possible model overrides without a forked context, whole-tool
permission denials, custom API endpoints, tool-search overrides, and
configured cache TTL values.

It **does not change files, enable tool search, weaken permissions, test a
gateway, or read subscription billing**. It does not print endpoint values
or file contents. Findings are heuristic and depend on the installed
Claude Code version. Broad deny rules may be deliberate security controls;
do not change them automatically for caching.

## 6. Optional isolated review context

~~~bash
npm run agents:review-prompt -- my-batch my-feature
~~~

After a feature completes, this generates a bounded, read-only review
assignment at:

~~~text
.git/agent-workflow/batches/<batch>/reviews/<feature>.md
~~~

Open the prompt in a **new** Claude/Codex/OpenCode session if you want a
separate review. This command deliberately does **not** start a paid
provider, change provider authorization, edit source files, or replace
the normal collection/integration review gates. It avoids mixing review
instructions into the coding worker's conversation.

## Upgrading existing projects

~~~bash
npm install --save-dev "github:oscoDOTblog/iwsdk-agent-kit#main"
npx iwsdk-agent-kit init --dry-run
~~~

The installer backs up and overwrites its managed runner scripts. If your
project has custom sandbox or worker logic, **do not run init blindly**.
Review the diff and port the new modules into the customized runner, as
with Medieval Gatekeeper. The installer preserves unmanaged agent files.
