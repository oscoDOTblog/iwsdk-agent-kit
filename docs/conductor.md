# Optional Conductor Mode (v0.5 foundation; v0.6 specialists)

v0.6 adds separately opt-in explorer, fixer-model, and diff-aware checker
profiles with targeted test evidence and per-role usage. These are disabled
by default; see [Specialist Workers](specialists.md).

Conductor Mode is an **opt-in supervisor** layered over the existing manual
worktree scheduler. It does not replace manual planning, provider isolation,
or the human review and publishing gates. It is disabled by default.

Conductor Mode works with a **previously approved batch**. The read-only AI
planner can **prioritize** existing tasks and flag risks; it cannot create
new tasks, change interfaces, expand owned paths, or edit the project.
AI-driven decomposition of an open-ended goal into a new batch is not part
of v0.5. Review the feature-batch JSON yourself before planning.

## Modes

| Workflow | Entry point | Model calls |
| --- | --- | --- |
| Manual (unchanged) | agents:plan / agents:start / agents:collect | Only explicitly launched workers |
| Deterministic conductor | agents:conduct with AI flags disabled | Only workers |
| AI-assisted conductor | agents:conduct with AI flags enabled | Read-only planner/verifier + workers |

Conductor Mode uses the same branches, worktrees, checkpoints, provider
authorization, and worker launcher as manual mode.

## Configuration

Set the following in iwsdk-agent-kit.config.json:

~~~json
{
  "backend": "claude",
  "providerIsolation": "strict",
  "workerModels": {
    "claude": "claude-opus-5-5"
  },
  "conductor": {
    "enabled": true,
    "provider": "claude",
    "aiPlanning": true,
    "aiVerification": true,
    "models": {
      "planner": "claude-fable-5-2",
      "verifier": "claude-sonnet-5-5"
    },
    "maxParallelWorkers": 2,
    "maxWorkerStarts": 8,
    "maxRetriesPerFeature": 0,
    "maxRunMinutes": 30,
    "autoIntegrate": false
  }
}
~~~

The model identifiers above are **examples**. Verify your installed CLI,
subscription eligibility, and actual model IDs before enabling paid calls.
No automatic model fallback or model switch is performed.

- **enabled:** false by default. Enabling config does not start anything.
  You must explicitly invoke agents:conduct with --approve.
- **provider:** Claude or Codex for the read-only AI planner/verifier.
  Other providers remain supported as implementation workers through the
  existing backend configuration. Cross-provider use requires explicit
  authorization on every affected command.
- **aiPlanning / aiVerification:** default true *inside Conductor Mode*;
  disable both for a deterministic, model-free supervisor.
- **models.planner / models.verifier:** optional role-specific model pins.
  Omitted pins use the CLI default. Implementation workers continue to use
  the existing per-provider workerModels setting from v0.4.
- **maxParallelWorkers:** 1..3. Overrides batch concurrency only during
  conductor scheduling; manual mode retains its original concurrency.
- **maxWorkerStarts:** 1..100, counted across **all attempts** in the batch.
  The conductor stops launching workers when this lifetime limit is reached.
- **maxRetriesPerFeature:** 0..2, default 0. Only a narrow class of
  recognizable transient failures can be retried. Quota, permission, auth,
  interrupted, dirty-worktree and unclassified failures are never retried
  automatically. Existing explicit retry safety checks still apply.
- **maxRunMinutes:** 1..240, per foreground conductor invocation. It
  limits *scheduling time*, **not the duration or cost of detached workers**.
  Active workers are not killed when the conductor pauses.
- **autoIntegrate:** must be false. There is no auto-publish or auto-merge.

Conductor settings are snapshotted on first invocation and reused when
resuming that batch. Disabling the feature in project config prevents
future conductor invocations. Existing manual commands remain available.

## Example workflow

~~~bash
# Review and approve your batch JSON as before.
npm run agents:plan -- features.json

# Starts the opt-in supervisor. It may spend model credits.
npm run agents:conduct -- my-batch --approve

# Read-only, never launches a model:
npm run agents:conduct-status -- my-batch
npm run agents:evidence -- my-batch
npm run agents:usage -- my-batch

# If a worker remains active or the supervisor paused, rerun the same command.
# The batch is resumed; completed work is not relaunched.
npm run agents:conduct -- my-batch --approve
~~~

If your configured provider is Codex and you explicitly want a Claude
conductor, add --allow-cross-provider claude --approve to the conduct
invocation. Worker backends are checked separately; every nonmatching
provider also requires its own named override. No flag is inferred from
model output.

The coordinator runs a read-only advisory model call (Claude with tools
disabled; Codex in read-only sandbox) to prioritize **existing** features.
The deterministic scheduler enforces ownership, dependency ordering,
preflight, concurrency and launch limits. The verifier can suggest
checks, but cannot approve acceptance, collect, integrate or publish.

Conductor state lives in the batch's Git common directory:

~~~text
.git/agent-workflow/batches/my-batch/
  conductor.json
  conductor/
    planner.jsonl
    verifier.jsonl
  acceptance-ledger.json
  <feature>/<attempt>/
    worker.jsonl
    summary.md
~~~

The supervisor uses an exclusive conductor lock plus the existing
per-batch scheduler lock. If it exits while detached workers are still
running, a later invocation reconciles receipts instead of relaunching
those workers.

## Commit-bound acceptance ledger

Every acceptance criterion begins as **pending**, even if a worker reports
that it passed. A reviewer must inspect real evidence and explicitly
record it. For example, after saving a test log inside the batch directory:

~~~bash
npm run agents:evidence -- my-batch toy 1 \
  --status passed --kind test \
  --artifact toy/1/test.log \
  --note "Reviewed the test output against criterion 1" --approve

npm run agents:evidence -- my-batch toy 2 \
  --status passed --kind runtime \
  --artifact evidence/quest-session.txt \
  --note "Personally checked interaction on Quest" --approve
~~~

The runtime evidence file must actually exist within the batch directory.
It is **not** created by the model. A file can be a test log, recorded
review, or runtime note; the reviewer remains responsible for its truth.
The ledger records the current feature commit and SHA-256 of the artifact.

A changed feature commit, deleted/modified artifact, or unpassed criterion
makes acceptance incomplete. Conductor batches cannot be collected or
integrated until the evidence is current. Manual batches keep their
original collection and integration behavior.

After reviewing every criterion:

~~~bash
npm run agents:conduct -- my-batch --approve
# phase: ready-for-collection

npm run agents:collect -- my-batch
# Existing architecture/test review and integration approval still apply.
npm run agents:integrate -- my-batch --approve
~~~

No automatic integration, publishing or deployment occurs.

## Limits and security

The conductor cannot guarantee a **monetary cap** or stop spending by a
worker already in flight. Worker-start limits and concurrency reduce
exposure but are not a hard dollar budget. Token usage depends on CLI
reporting, and the planner/verifier usage is logged separately. A failed
model call never silently switches providers.

The planner's output is treated as untrusted advice. It can reorder only
approved feature IDs, never override dependencies or modify the batch.
The verifier has no authority to mark evidence passed. The coordinator
cannot call worker tools, change security settings, or bypass the existing
review and publishing gates.

## Upgrading customized projects

The installer copies new modules and scripts, but it can overwrite
managed scripts after creating backups. **If your IWSDK project has a
customized worker runner, review init --dry-run and port the modules
deliberately rather than blindly running init.** Existing manual
batches and scripts remain supported.
