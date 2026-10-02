import type { Check, Config, Snapshot } from '../src/model.ts';

export const HEAD = 'a'.repeat(40);
export const OLD = 'b'.repeat(40);
export const NOW = new Date('2026-10-02T12:00:00Z');

/** The ISO time `min` minutes before NOW. */
export const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

export const cfg: Config = { firstReview: 'gate', requiredChecks: ['verify'], ignoreChecks: [], ownWorkflow: 'merge-gate' };

export const check = (name: string, state: Check['state'], over: Partial<Check> = {}): Check => ({
  workflow: 'CI',
  name,
  state,
  at: ago(5),
  ...over,
});

export const GREEN: Check[] = [check('verify', 'success'), check('api', 'success')];

/** A ready pull request, never handed to the gate, CI green, never reviewed. */
export function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    id: 'PR_node',
    number: 7,
    open: true,
    draft: false,
    head: HEAD,
    labeled: false,
    labeledAt: null,
    copilotQueued: false,
    copilotRequestedAt: null,
    copilotReviews: [],
    unresolvedThreads: 0,
    checks: GREEN,
    gateStatus: null,
    note: null,
    ...over,
  };
}

/** The same pull request, held by the gate: draft and labeled. */
export const held = (over: Partial<Snapshot> = {}) => snap({ draft: true, labeled: true, labeledAt: ago(10), ...over });

export const reviewed = (commit: string, comments: number, minAgo = 3) => ({ commit, comments, submittedAt: ago(minAgo) });
