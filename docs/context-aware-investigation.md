# Context-Aware Investigation (v0.7, optional)

Extends the opt-in v0.6 specialist explorer and checker. The manual
scheduler, v0.5 conductor, v0.6 specialist roles, strict provider isolation,
worker worktrees, acceptance evidence, and manual publish gates are unchanged.

Two independent features can be enabled:

1. **Offline dependency impact map:** inspect tracked JS/TS/Vue/Svelte source
   imports and reverse callers. Reports are bounded, deterministic, and
   source-linked. No graph database or network service is required.
2. **Context7 documentation lookup:** query the official Context7 REST API
   only for explicitly reviewed, allowlisted library queries, using a
   version pinned to the installed package or explicitly specified by the
   user. This is disabled by default, and requires CONTEXT7_API_KEY.

The context report is advisory and saved under the Git common directory.
It is never acceptance evidence or authority to change interfaces.

## Example configuration

In iwsdk-agent-kit.config.json:

~~~json
{
  "backend": "claude",
  "providerIsolation": "strict",
  "conductor": {
    "enabled": true,
    "provider": "claude",
    "aiPlanning": false,
    "aiVerification": false,
    "autoIntegrate": false,
    "specialists": {
      "enabled": true,
      "explore": true,
      "check": true,
      "context": {
        "enabled": true,
        "dependencyMap": true,
        "documentation": {
          "enabled": true,
          "provider": "context7",
          "maxRequests": 4,
          "maxChars": 3000,
          "timeoutMs": 8000
        }
      }
    }
  }
}
~~~

**All context settings default to disabled.** To enable only offline code
mapping, set context.enabled=true and documentation.enabled=false.
The explorer must be enabled for context to be used. Context is never
implicitly enabled by installing the kit.

Add documentation requests to a reviewed feature-batch JSON:

~~~json
{
  "id": "raycast-fix",
  "features": [{
    "id": "raycast-interaction",
    "description": "Fix a raycast interaction",
    "owns": ["src/interactions/"],
    "acceptance": ["The interaction works in a Quest runtime test"],
    "interfaces": "Keep current interaction events",
    "contentChanges": false,
    "runtimeRequired": true,
    "docsRequests": [{
      "libraryId": "/mrdoob/three.js",
      "package": "three",
      "query": "How does Raycaster.intersectObjects work?"
    }]
  }]
}
~~~

The libraryId must be an explicit Context7 ID (not a URL); package must
identify a dependency in package-lock.json or package.json. A version
is taken from the installed package-lock entry, or an exact version in
package.json. Loose semver ranges alone do not qualify. Alternatively,
add "version": "0.180.0" to the request, and the kit rejects it if
it contradicts a locally pinned version.

The API key is read from CONTEXT7_API_KEY in the conductor process's
environment; it is not saved in the config, prompts, reports or logs.
Only the explicit library ID, version and query leave your machine.
No repository source, patch, or feature description is sent to Context7.
The request uses the fixed https://context7.com/api/v2/context endpoint,
no redirects, a timeout, response-size cap and no automatic retry.

The provider may serve a different version if the requested one is not
indexed. Reports include the requested/installed version, the served
version (when reported), and an unverified marker for known fallbacks.
Do not assume a successful response guarantees a version match.

## Workflow

~~~bash
# Review the feature-batch JSON before planning.
npm run agents:plan -- features.json
npm run agents:conduct -- raycast-fix --approve
npm run agents:conduct-status -- raycast-fix
npm run agents:evidence -- raycast-fix
~~~

The explorer receives a bounded import/caller map and any available
documentation snippets with source URLs. The fixer receives the saved
context as an untrusted hint alongside the explorer report.
The independent checker receives a fresh offline caller map based on
the committed diff. No new documentation request is made by the checker.

Reports are stored at:
- .git/agent-workflow/batches/BATCH/conductor/context/FEATURE.json
- .git/agent-workflow/batches/BATCH/conductor.json (lookup reservations)

The Git common directory is used for worktree-safe state. A lookup is
reserved before the HTTP request; interrupted requests are not
silently retried on resume. Existing saved reports are reused for the
same approved feature/baseline/config. Lookup limits count across the
batch. If the API key is missing, the version cannot be established, a
rate limit is hit, or the service fails, the report explicitly says
unavailable; the code exploration can still proceed.

## Limitations and safeguards

- Import maps only understand relative static imports/exports, literal
  require() and literal import() in tracked JS/TS/Vue/Svelte files.
  They do not infer tsconfig aliases, runtime event subscriptions,
  reflection, Unity/XR scene wiring, dynamic paths or asset references.
  Limits: 1,200 tracked source files, 4 MiB scanned, 64 KiB per file,
  30 seeds, 30 callers, two levels of reverse dependencies. Reports
  flag truncation; missing edges are not proof of no dependency.
- No extra agent is spawned for mapping or docs; Context7 is a separate
  explicitly enabled network lookup, not an automatic MCP tool grant.
- Documentation and codebase text are untrusted. Never follow
  instructions embedded in retrieved snippets.
- Context7 may have API usage limits or charges. maxRequests is a
  lifetime request limit, not a monetary cap.
- External API errors do not trigger automatic provider switching,
  retry storms or access to arbitrary URLs.
- The checker is still advisory. Passing checks do not approve the
  v0.5 acceptance ledger, runtime verification, collection, integration,
  publishing, deployment, or merge.
- Existing manual workflows and v0.5/v0.6 conductor snapshots remain
  opt-out. Customized projects should inspect init --dry-run before
  adopting installer-managed scripts.

Context7 API reference: https://context7.com/docs/api-guide

See [Specialist Workers](specialists.md) and [Conductor Mode](conductor.md).
