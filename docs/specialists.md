# Optional Specialist Workers (v0.6)

This layer extends opt-in v0.5 Conductor Mode. It does not replace the manual
scheduler, provider isolation, worker permissions, or human-reviewed acceptance
ledger. **All specialist profiles are off by default.**

## Roles

- **Explorer:** read-only Claude (Read/Grep/Glob) or read-only-sandbox Codex.
  Returns JSON with a <=200-word summary, 1..12 existing relative source file
  references (path, line, reason), and risks. References are verified before
  saving. They are hints; the fixer must inspect its own worktree.
- **Fixer:** the existing isolated feature worker. An optional model pin
  overrides the usual worker model only if the backend matches the conductor
  provider. Existing Git ownership, permissions, and start limits still apply.
- **Checker:** a separate read-only model invocation given the actual Git diff
  from feature.startHead to feature.head and deterministic targeted test
  results. It returns advisory verdict and changed-file findings.
- **Targeted tests:** explicit per-feature test paths run with node --test PATH,
  without a shell, with timeout and saved logs. Model output cannot supply
  commands or select tests.

The v0.5 planner/verifier remain unchanged. Specialist calls are sequential,
counted before invocation, and never automatically retried or switched.

## Enable

Example iwsdk-agent-kit.config.json:

~~~json
{
  "backend": "claude",
  "providerIsolation": "strict",
  "conductor": {
    "enabled": true,
    "provider": "claude",
    "aiPlanning": false,
    "aiVerification": false,
    "maxParallelWorkers": 2,
    "maxWorkerStarts": 8,
    "autoIntegrate": false,
    "specialists": {
      "enabled": true,
      "explore": true,
      "check": true,
      "models": {
        "explorer": "haiku",
        "fixer": "sonnet",
        "checker": "sonnet"
      },
      "maxCalls": 12,
      "maxExplorerCalls": 6,
      "maxCheckerCalls": 6,
      "maxDiffChars": 16000,
      "maxTestSeconds": 30
    }
  }
}
~~~

Model aliases are illustrative. Verify installed CLI support and availability.
Specialists use the configured conductor provider, never a provider chosen
by a model. A fixer model pin requires all feature workers to use the same
provider. Existing provider-isolation checks run before inference.

In your reviewed batch JSON, add optional test paths per feature:

~~~json
{
  "id": "interaction-fixes",
  "backend": "claude",
  "features": [{
    "id": "npc-response",
    "description": "Fix the existing NPC response",
    "owns": ["src/npc/"],
    "acceptance": ["NPC responds to the approved interaction"],
    "interfaces": "No API changes",
    "contentChanges": false,
    "runtimeRequired": true,
    "targetedTests": ["tests/npc-response.test.mjs"]
  }]
}
~~~

Test paths must be relative *.test.js/mjs/cjs or *.spec.js/mjs/cjs files,
without globbing or shell metacharacters. Missing test files block the check.
No configured tests means no automated tests ran. A passing test does not
replace Quest/headset runtime acceptance.

~~~bash
npm run agents:plan -- features.json
npm run agents:conduct -- interaction-fixes --approve
npm run agents:conduct-status -- interaction-fixes
npm run agents:usage -- interaction-fixes --json
npm run agents:evidence -- interaction-fixes
~~~

Investigations are saved in conductor/investigations/FEATURE.json; checker
reports in conductor/checks/FEATURE.json; and test logs in
conductor/tests/FEATURE/N.log, under the Git common-directory batch state.
Reports bind to commit SHAs, patch SHA-256, test-log SHA-256 and observed usage.
Truncated diffs are marked needs-human, not passed. Failed tests remain failed
even if the model says the patch looks correct.

Usage reports add planner, explorer, fixer, checker, verifier role totals
only for opted-in batches. Unknown token fields remain unknown. Invocation
limits do not imply monetary or subscription quota caps.

## Safeguards

- No automatic acceptance, collection, integration, publishing, or merging.
  The v0.5 evidence ledger remains authoritative.
- A crashed specialist reservation still consumes a call. Existing detached
  workers may continue after the foreground conductor pauses.
- The checker sees a bounded patch and is advisory, not proof of correctness.
- Targeted tests execute project code and may have side effects. Only explicit
  paths from the approved batch run. Dirty worktrees are preserved and flagged.
- Read-only CLI tool restrictions are not OS-level security boundaries.
- Older v0.5 conductor snapshots migrate with specialists disabled.
  Manual plan/start/collect does not run any specialist or targeted test.
- The installer updates managed scripts after backup. Review init --dry-run
  before applying to a project with customized agent scripts.

See [Conductor Mode](conductor.md), [provider isolation](provider-isolation.md),
and [security](security.md).
