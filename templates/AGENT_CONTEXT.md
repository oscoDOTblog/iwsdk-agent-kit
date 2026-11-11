# Shared Agent Context

This file is the **human-reviewed, version-controlled project memory** for Codex,
Claude Code, OpenCode and Muse Code. All harnesses must read it before changing code.

> Keep this short, factual, and safe to commit. Do not store credentials, private
> transcripts, personal data, or unverified claims. Update it between feature
> batches or at deliberate review checkpoints, not concurrently from workers.

## Project goal

<!-- What are we building, for whom, and what does done mean? -->

## Current architecture

<!-- IWSDK version, entry points, enabled features, important systems and contracts. -->

## Decisions and constraints

<!-- Decisions that later agents must not casually reverse. -->

## Current milestone and status

<!-- Confirmed working behavior; what remains. Link to commits/PRs when useful. -->

## Verification

<!-- Commands actually run, latest results, Quest/browser checks and limitations. -->

## Next actions

<!-- Small, prioritized, concrete next steps with ownership if known. -->

## Handoff protocol

- Read this file, AGENTS.md, and any feature handoff path supplied by the runner.
- Check `git status`, recent commits and current branch before modifying files.
- When interrupted or out of quota, stop and report; do not erase partial changes.
- Coordinator-generated per-feature checkpoints live in the Git common directory at
  `agent-workflow/batches/<batch>/handoffs/<feature>.md` and are not auto-committed.
- A new backend may continue only after an explicit, reviewed handoff.
