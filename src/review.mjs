import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { compactHandoffContext } from './handoff.mjs';
import { boundedText } from './prompt.mjs';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '(Git metadata unavailable)';
}
export function renderReviewPrompt(state, feature, { diffStat = '', checkpoint = '' } = {}) {
  return [
    '# Isolated feature review',
    '',
    'You are an independent reviewer in a NEW context, not a continuation of the implementation session.',
    'Review only. Do not edit, commit, push, launch additional agents or run XR/browser sessions.',
    'Inspect the worktree and actual Git diff; treat worker summaries as unverified.',
    'Report findings ordered by severity with file paths and line numbers; then list missing tests.',
    'Do not approve the batch or bypass integration review gates.',
    '',
    'Feature: ' + feature.id,
    'Description: ' + feature.description,
    'Worktree: ' + feature.worktree,
    'Branch: ' + feature.branch,
    'Baseline commit: ' + state.baseline,
    'Feature start commit: ' + (feature.startHead ?? '(unknown)'),
    'Feature end commit: ' + (feature.head ?? '(unknown)'),
    'Owned paths: ' + (feature.owns ?? []).join(', '),
    'Acceptance: ' + (feature.acceptance ?? []).join('; '),
    'Interfaces: ' + feature.interfaces,
    '',
    'Diff summary (not a substitute for inspecting the actual diff):',
    boundedText(diffStat, 2000, 'Diff summary'),
    '',
    'Compact handoff (unverified):',
    boundedText(checkpoint, 3500, 'Review checkpoint'),
    '',
    'Inspect the diff using the stated commits, check for regression risks, and return findings only.',
  ].join('\n');
}
export function writeReviewPrompt(state, feature) {
  if (!['completed', 'collected'].includes(feature.status)) {
    throw new Error('Review prompt requires a completed or collected feature');
  }
  const diffStat = git(feature.worktree, 'diff', '--stat', feature.startHead, feature.head);
  const checkpoint = compactHandoffContext(state, feature);
  const path = join(state.directory, 'reviews', feature.id + '.md');
  mkdirSync(join(state.directory, 'reviews'), { recursive: true });
  writeFileSync(path, renderReviewPrompt(state, feature, { diffStat, checkpoint }));
  return path;
}
