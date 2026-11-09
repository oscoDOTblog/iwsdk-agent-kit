# Security and trust boundaries

Agent instructions and command allowlists are not security sandboxes. Run this toolkit only with trusted dependencies and a trusted project checkout.

Workers operate in Git worktrees. That isolates checked-out files but does not isolate network, credentials, headset, browser sessions or shared services. Avoid running different workers against the same XR runtime. The runner does not enable blanket permission bypass.

Running `npm ci` may execute dependency lifecycle scripts. Review lockfiles and dependencies. No automated PR merge or deployment is performed. Publishing and cleanup require explicit approval.

Do not include personal absolute paths, access tokens, private project files or licensed assets when publishing this template. Use separate environment-specific secrets management for each project.

Mocked tests do not establish live CLI authentication or headset compatibility.
