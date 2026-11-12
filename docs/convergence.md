# Optional Convergence Loop (v0.8)

v0.8 adds an **opt-in, bounded deterministic test/repair loop** on top of
v0.5 Conductor Mode, v0.6 specialists and v0.7 context mapping. Manual mode,
provider isolation, existing worktrees, evidence acceptance, integration and
publishing gates are unchanged. **It is disabled by default.**

## What it does

- **Red-to-green regression proof:** For an explicitly selected test that
  already exists and is byte-identical at the feature's starting commit and
  final commit, run the test at both commits. Record the actual baseline
  failure and the head result with immutable commit SHA references, test
  logs, and hashes. A passing baseline, changed/missing test or unresolved
  test environment is *not* accepted as red-to-green proof.
- **Structured feedback:** When a targeted test fails, extract a small,
  deterministic report: failing test path, expected/observed diagnostics,
  fingerprint, SHA-bound log references and prior failure fingerprints.
  The fixer receives a bounded, untrusted summary rather than raw logs.
- **Bounded repair:** If tests failed, the feature is completed/clean,
  ownership is valid, dependencies have not started, and both per-feature
  and total worker budgets permit it, queue a repair in the **same feature
  worktree and provider**. The next explicitly approved conduct invocation
  starts the existing worker runner. It must commit a **new** revision.
- **Repeat stop:** If two different feature commits fail with the same
  deterministic test signature, stop and request human diagnosis. Do not
  burn further model calls on a non-converging approach.

The independent checker is not invoked for a deterministically failing test
when Convergence Loop is enabled. A passing test still goes to the independent
checker. A checker failure or unverified regression proof needs human review;
**model opinion alone cannot trigger automatic repair**.

## Opt in

In iwsdk-agent-kit.config.json:

~~~json
{
  "backend": "codex",
  "providerIsolation": "strict",
  "conductor": {
    "enabled": true,
    "provider": "codex",
    "aiPlanning": false,
    "aiVerification": false,
    "maxWorkerStarts": 5,
    "maxRetriesPerFeature": 0,
    "autoIntegrate": false,
    "specialists": {
      "enabled": true,
      "explore": false,
      "check": true
    },
    "convergence": {
      "enabled": true,
      "maxRepairsPerFeature": 1,
      "maxFeedbackChars": 1800
    }
  }
}
~~~

Defaults: enabled=false, maxRepairsPerFeature=1 (0..2 allowed),
maxFeedbackChars=1800 (500..4000 allowed). The conductor, specialists and
checker must all be enabled to enable convergence. The config is snapshotted
on the first conduct invocation, so existing v0.5–v0.7 batches stay opted
out even if project defaults later change.

In a reviewed batch feature:

~~~json
{
  "id": "bug-fix",
  "description": "Fix the existing bug",
  "owns": ["src/interactions/"],
  "acceptance": ["The interaction works on Quest"],
  "interfaces": "Keep existing input events",
  "contentChanges": false,
  "runtimeRequired": true,
  "targetedTests": ["tests/interaction.test.mjs"],
  "regressionTests": ["tests/interaction.test.mjs"]
}
~~~

- targetedTests: explicit paths, each run using node --test with no shell.
- regressionTests: optional subset of targetedTests, maximum four files.
  Every regression test **must already be tracked and identical at both
  commits**. If you add a new test in the same patch, v0.8 cannot
  automatically establish red-to-green proof; have a reviewer inspect
  the baseline reproduction separately. A future version could support
  safely overlaying a new test onto a baseline checkout.
- If regressionTests is omitted, failed targeted tests can still generate
  feedback and a bounded repair, but **no red-to-green claim is made**.

## Commands

~~~bash
npm run agents:plan -- features.json
npm run agents:conduct -- my-batch --approve
npm run agents:conduct-status -- my-batch

# If a repair is queued, review the feedback and explicitly resume:
npm run agents:conduct -- my-batch --approve

# After checks pass, acceptance still requires independent human evidence:
npm run agents:evidence -- my-batch
npm run agents:collect -- my-batch
npm run agents:integrate -- my-batch --approve
~~~

The repair action is guarded by the coordinator. Direct use of
agents:repair requires an opted-in conductor batch, current deterministic
failure feedback, a completed clean worktree, provider authorization and
--approve. It is not available for manual batches.

Artifacts in the Git common-directory batch state:
- conductor/tests/FEATURE/COMMIT/INDEX.log
- conductor/regression/FEATURE/COMMIT.json
- conductor/feedback/FEATURE.json
- conductor.json (failure fingerprints, role calls and snapshot)
- handoffs/FEATURE.compact.md (repair context passed by reference)

## Safety and limitations

- The baseline is checked out in a **temporary detached Git worktree**.
  Node's built-in test runner executes the approved test. If the feature
  worktree already has node_modules and package-lock.json is unchanged,
  those dependencies are reused by a temporary symlink. No automatic
  npm install is performed for the baseline. A missing dependency is
  reported as unavailable rather than a verified bug reproduction.
- Tests run local project code; enable this only in a trusted repository.
  Each test has the v0.6 timeout, path validation and output limit.
  The baseline test is not executed by an LLM.
- Only TAP failure names, expected, actual and error fields enter compact
  feedback. Test logs remain on disk; no raw log is automatically sent
  to an agent. As with any test output, avoid printing secrets.
- Missing-module/dependency errors are escalated for environment diagnosis
  rather than automatically triggering a code repair.
- The fingerprint detects repeated *observed* failures; it cannot prove
  two root causes are identical, or recognize every semantically identical
  error. A repeat stop requires a human to reassess the task.
- The repair command refuses a dirty/moved branch, ownership violations,
  started dependents, collection/review/integration, or exhausted budgets.
  It never resets, stashes, discards or overwrites user work.
- Worker starts are counted across repairs. The scheduling deadline is not
  a hard token/dollar cap, and detached workers are not killed on timeout.
- The checker is still advisory; test evidence is not an automatic approval.
  Runtime/headset acceptance, manual integration, publishing and merging
  remain explicitly controlled by a person.

See [Conductor Mode](conductor.md), [Specialist Workers](specialists.md),
and [Context-Aware Investigation](context-aware-investigation.md).
