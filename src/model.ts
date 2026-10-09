/** The label a pull request carries while the gate holds it: finalized, kept in draft until it may open. */
export const LABEL = 'merge-gate';
/** The one commit status the gate publishes on a pull request's head. */
export const CONTEXT = 'merge-gate';

export const COPILOT_LOGIN = 'copilot-pull-request-reviewer';
/** Node id of the Copilot reviewer bot — the same on every repository. */
export const COPILOT_BOT_ID = 'BOT_kgDOCnlnWA';
/** Each Copilot review runs as an Actions run of this dynamic workflow. */
export const COPILOT_WORKFLOW = 'Copilot';

/** Marks the comment that records a head going without a Copilot review. */
export const NOTE_MARK = '<!-- merge-gate:unreviewed';
/** One repository variable per pull request waiting on Copilot; the scheduled sweep runs only while one exists. */
export const AWAIT_PREFIX = 'MERGE_GATE_AWAIT_';

/** A review queued this long without being submitted will not come: the gate opens without it. */
export const COPILOT_TIMEOUT_MIN = 20;
/** With `first-review: ruleset`, how long the ruleset gets to request the first review itself. */
export const RULESET_GRACE_MIN = 5;
/** How long a request gets to show up in the review queue before the gate calls it ignored. */
export const REGISTER_WAIT_S = 20;

/** `cancelled`: a run stopped before its end — a failure on its own, nothing once a non-cancelled run of the check exists. */
export type CheckState = 'success' | 'failure' | 'pending' | 'ignored' | 'cancelled';

export interface Check {
  /** Workflow of an Actions check run; empty for a commit status or another app's check. */
  workflow: string;
  name: string;
  state: CheckState;
  /** Orders several runs of the same check: the latest one speaks. */
  at: string;
}

export interface CopilotReview {
  commit: string;
  submittedAt: string;
  /** Inline comments, i.e. the threads this review opened. */
  comments: number;
}

export type Unreviewed = 'quota' | 'ignored' | 'timeout';

export interface Note {
  id: string;
  head: string;
  reason: Unreviewed;
}

export interface Snapshot {
  id: string;
  number: number;
  open: boolean;
  draft: boolean;
  head: string;
  labeled: boolean;
  /** Latest time the gate's label was added: when the pull request was handed to the gate. */
  labeledAt: string | null;
  copilotQueued: boolean;
  copilotRequestedAt: string | null;
  /** Oldest first. */
  copilotReviews: CopilotReview[];
  unresolvedThreads: number;
  checks: Check[];
  gateStatus: { state: string; description: string } | null;
  note: Note | null;
}

export interface Config {
  firstReview: 'gate' | 'ruleset';
  requiredChecks: readonly string[];
  ignoreChecks: readonly string[];
  /** Name of the workflow running the gate, whose own checks never count. */
  ownWorkflow: string;
}

export interface Quota {
  exhausted: boolean;
  /** Of the included entitlement. Negative past it, which is not the same as out of credits. */
  remaining: number | null;
  /**
   * Of the overage allowance GitHub keeps billing against once the entitlement is spent. `null` when
   * no overage is permitted, and when the answer permits one without sizing it. Negative when the
   * counter has gone past the cap, which token-based billing (`true` on the 2026-10-03 payload)
   * would allow — a single review costing more than the room that was left. Never observed.
   */
  overageRemaining: number | null;
  resetAt: string | null;
}
