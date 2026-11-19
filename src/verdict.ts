import {
  CONTEXT,
  COPILOT_LOGIN,
  COPILOT_TIMEOUT_MIN,
  COPILOT_WORKFLOW,
  RULESET_GRACE_MIN,
  type Check,
  type Config,
  type LovableFailure,
  type Quota,
  type Snapshot,
  type Unreviewed,
} from './model.ts';

export interface Ci {
  state: 'green' | 'pending' | 'red';
  failing: string[];
  pending: string[];
  /** A pending commit status, such as a deployment's: no workflow event announces its end. */
  statusPending: boolean;
}

export type Review =
  /** The pull request's one review is in: Copilot's, or the Lovable relay's in its place. */
  | { kind: 'done'; by: 'copilot' | 'lovable' }
  /** A review is due and nobody asked for it. */
  | { kind: 'due' }
  /** Copilot is queued. */
  | { kind: 'waiting' }
  /** `first-review: ruleset` — the ruleset still has time to request the first review. */
  | { kind: 'grace' }
  /** Copilot cannot review this head, nor the relay when `lovable` is set: the gate opens without a review, and says so. */
  | { kind: 'unreviewed'; reason: Unreviewed; lovable: LovableFailure | null }
  /** Copilot cannot review this head and the Lovable relay will, once the CI is not red and no thread is open. */
  | { kind: 'lovable'; reason: Unreviewed }
  /** Another run of the gate is having the relay review this head: none starts a second one. */
  | { kind: 'relaying'; reason: Unreviewed };

export interface Status {
  state: 'pending' | 'success' | 'failure';
  description: string;
}

export interface Plan {
  kind: 'closed' | 'work-draft' | 'hold' | 'open';
  label: 'add' | 'remove' | null;
  draft: 'to-draft' | 'to-ready' | null;
  request: boolean;
  status: Status | null;
  /** Record that this head goes without a review, and why. */
  note: { reason: Unreviewed; lovable: LovableFailure | null } | null;
  /** Where the review stands once the quota is read: what the gate acts on. */
  review: Review;
  /**
   * Keep the variable that wakes the scheduled sweep. Copilot's review raises no event the gate can run on,
   * and neither does a commit status such as a deployment's.
   */
  awaiting: boolean;
}

export const REASONS: Record<Unreviewed, string> = {
  quota: 'crédits Copilot épuisés',
  overage: 'crédits Copilot inclus épuisés, dépassement payant évité',
  refused: 'demande refusée par GitHub (crédits, dépôt ou compte non éligible)',
  ignored: 'demande ignorée par Copilot (quota ou panne)',
  timeout: `Copilot n’a pas rendu sa revue en ${COPILOT_TIMEOUT_MIN} min`,
};

export const LOVABLE_REASONS: Record<LovableFailure, string> = {
  credits: 'crédits Lovable épuisés',
  token: 'jeton du relais Lovable refusé',
  unavailable: 'relais Lovable sans réponse',
};

/** A commit status description holds at most 140 characters. */
const DESCRIPTION_MAX = 140;

function excluded(c: Check, cfg: Config): boolean {
  return (
    c.workflow === cfg.ownWorkflow ||
    c.workflow === COPILOT_WORKFLOW ||
    c.name === COPILOT_LOGIN ||
    c.name.startsWith(CONTEXT) ||
    cfg.ignoreChecks.includes(c.name)
  );
}

/** How much a run says about the code: a result or a run in flight, then a cancelled run, then a stale one. */
const WEIGHT: Record<Check['state'], number> = { success: 2, failure: 2, pending: 2, cancelled: 1, ignored: 0 };

/**
 * The run of a check that speaks for it: the latest one, except that a cancelled run yields to any
 * non-cancelled run of the same check, whichever started later. A second batch of the same workflow
 * on one commit cancels the first (`cancel-in-progress`, or the gate's own draft conversion firing
 * `converted_to_draft` seconds after the push), and the cancelled jobs can carry the later
 * `startedAt`. Alone, or beside only stale runs, a cancelled run fails. Known limit: a run cancelled
 * by hand after an earlier pass of the same check leaves that pass standing — the rollup covers one
 * head commit, so the pass is of the same code.
 */
function speaking(a: Check | undefined, b: Check): Check {
  if (!a) return b;
  const weight = WEIGHT[b.state] - WEIGHT[a.state];
  if (weight !== 0) return weight > 0 ? b : a;
  return b.at > a.at ? b : a;
}

/** The CI verdict on the head, the gate's and Copilot's own checks left out. */
export function ciVerdict(checks: readonly Check[], cfg: Config): Ci {
  const latest = new Map<string, Check>();
  for (const c of checks) {
    if (excluded(c, cfg)) continue;
    const key = `${c.workflowId ?? c.workflow}\u0000${c.name}`;
    latest.set(key, speaking(latest.get(key), c));
  }
  const kept = [...latest.values()].filter((c) => c.state !== 'ignored');
  const failing = kept.filter((c) => c.state === 'failure' || c.state === 'cancelled').map((c) => c.name);
  const running = kept.filter((c) => c.state === 'pending');
  const pending = running.map((c) => c.name);
  for (const name of cfg.requiredChecks) {
    if (!kept.some((c) => c.name === name)) pending.push(name);
  }
  if (kept.length === 0 && cfg.requiredChecks.length === 0) pending.push('aucun check');
  const state = failing.length > 0 ? 'red' : pending.length > 0 ? 'pending' : 'green';
  return { state, failing, pending, statusPending: running.some((c) => c.workflow === '') };
}

function minutesSince(iso: string, now: Date): number {
  return (now.getTime() - Date.parse(iso)) / 60_000;
}

/**
 * How long the gate's "Lovable relit" status stands for a review in flight: the job's timeout
 * (`timeout-minutes` in .github/workflows/gate.yml), past which the run that wrote it is dead.
 */
export const LOVABLE_RUN_MIN = 20;

const relayingText = (reason: Unreviewed) => `Lovable relit (${REASONS[reason]})`;
const lovableLaterText = (reason: Unreviewed) => `relecture Lovable à venir (${REASONS[reason]})`;

/**
 * The reason a run is having the relay review this head right now, read off the status it wrote
 * before starting; null when none is. Without it, the sweep — whose runs share no concurrency group
 * with the pull request's — would start a second review of the head while the first runs.
 */
function relaying(s: Snapshot, now: Date): Unreviewed | null {
  const st = s.gateStatus;
  if (st?.state !== 'pending' || !st.at || minutesSince(st.at, now) >= LOVABLE_RUN_MIN) return null;
  return (Object.keys(REASONS) as Unreviewed[]).find((reason) => st.description.includes(relayingText(reason))) ?? null;
}

/**
 * Where the head stands with Copilot. Copilot reviews a pull request once: a review is due only while the
 * pull request has none. Every later push, those answering its threads included, costs no review.
 */
export function reviewState(s: Snapshot, cfg: Config, now: Date): Review {
  const last = s.copilotReviews.at(-1);
  // The relay's review stands for Copilot's: one review a pull request, whoever wrote it.
  const due = !last && !s.lovableReview;
  const done = { kind: 'done', by: last ? 'copilot' : 'lovable' } as const;
  // First: a run reviewing this head through the relay stands whatever else the pull request says —
  // Copilot still queued past its timeout, or a note — or another run would start a second review.
  const inFlight = due ? relaying(s, now) : null;
  if (inFlight) return { kind: 'relaying', reason: inFlight };
  const noted = s.note?.head === s.head ? s.note : null;
  if (s.copilotQueued) {
    const since = s.copilotRequestedAt ?? s.labeledAt;
    if (since && minutesSince(since, now) >= COPILOT_TIMEOUT_MIN) {
      return due ? { kind: 'unreviewed', reason: 'timeout', lovable: noted?.lovable ?? null } : done;
    }
    return { kind: 'waiting' };
  }
  if (!due) return done;
  if (noted) return { kind: 'unreviewed', reason: noted.reason, lovable: noted.lovable };
  if (cfg.firstReview === 'ruleset') {
    if (!s.labeledAt || minutesSince(s.labeledAt, now) < RULESET_GRACE_MIN) return { kind: 'grace' };
  }
  return { kind: 'due' };
}

/** The gate asks Copilot only when a review is due, no thread is open and the CI is not red. */
export function wantsRequest(s: Snapshot, ci: Ci, review: Review): boolean {
  return s.open && review.kind === 'due' && s.unresolvedThreads === 0 && ci.state !== 'red';
}

function clip(text: string): string {
  return text.length <= DESCRIPTION_MAX ? text : `${text.slice(0, DESCRIPTION_MAX - 1)}…`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * What to do with the pull request. `quota` is read only when a request is wanted; `null` means
 * unknown, and an unknown quota never stops a request. With `lovable`, a head Copilot cannot review
 * goes to the relay instead of opening unreviewed, and Copilot's paid overage is not spent.
 * `relayFree` false: this run has already had the relay review another pull request, so this one
 * waits for a later run, held and awaited, its status saying the review is still to come.
 */
export function decide(s: Snapshot, ci: Ci, review: Review, quota: Quota | null, lovable = false, relayFree = true): Plan {
  const nothing = { label: null, draft: null, request: false, note: null, awaiting: false, review } as const;
  if (!s.open) return { kind: 'closed', ...nothing, status: null };
  if (s.draft && !s.labeled) {
    return {
      kind: 'work-draft',
      ...nothing,
      status: { state: 'pending', description: 'Brouillon de travail — passer la PR en prête pour la confier à la porte' },
    };
  }

  let r = review;
  let request = false;
  if (wantsRequest(s, ci, r)) {
    if (quota?.exhausted) r = { kind: 'unreviewed', reason: 'quota', lovable: null };
    else if (lovable && quota?.overage) r = { kind: 'unreviewed', reason: 'overage', lovable: null };
    else {
      request = true;
      r = { kind: 'waiting' };
    }
  }
  // The relay has not tried this head yet: it reviews instead of the pull request opening unreviewed.
  if (lovable && r.kind === 'unreviewed' && r.lovable === null) r = { kind: 'lovable', reason: r.reason };
  const note =
    r.kind === 'unreviewed' && (s.note?.head !== s.head || s.note.reason !== r.reason || s.note.lovable !== r.lovable)
      ? { reason: r.reason, lovable: r.lovable }
      : null;

  if (ci.state === 'green' && s.unresolvedThreads === 0 && (r.kind === 'done' || r.kind === 'unreviewed')) {
    return {
      kind: 'open',
      label: s.labeled ? 'remove' : null,
      draft: s.draft ? 'to-ready' : null,
      request: false,
      note,
      awaiting: false,
      review: r,
      status:
        r.kind === 'unreviewed'
          ? {
              state: 'success',
              description: clip(`Prête — NON relue par Copilot : ${REASONS[r.reason]}${r.lovable ? ` · ni par Lovable : ${LOVABLE_REASONS[r.lovable]}` : ''}`),
            }
          : r.by === 'lovable'
            ? { state: 'success', description: 'Prête — CI verte, relue par Lovable à la place de Copilot, aucun fil ouvert' }
            : { state: 'success', description: 'Prête — CI verte, relue par Copilot, aucun fil ouvert' },
    };
  }

  const parts: string[] = [];
  let authorMustAct = false;
  if (ci.state === 'red') {
    authorMustAct = true;
    parts.push(`CI rouge : ${ci.failing.join(', ')}`);
  }
  if (s.unresolvedThreads > 0) {
    authorMustAct = true;
    parts.push(`${plural(s.unresolvedThreads, 'fil ouvert', 'fils ouverts')} à traiter`);
  }
  if (r.kind === 'waiting') parts.push(request ? 'revue Copilot demandée' : 'Copilot relit');
  if (r.kind === 'grace') parts.push('attend la revue Copilot du ruleset');
  if (r.kind === 'unreviewed') parts.push(`sans revue Copilot (${REASONS[r.reason]})`);
  // The gate runs the relay's review in this very run when nothing is for the author to fix and the
  // run has not had it review another pull request already.
  if (r.kind === 'lovable') parts.push(authorMustAct || !relayFree ? lovableLaterText(r.reason) : relayingText(r.reason));
  if (r.kind === 'relaying') parts.push(relayingText(r.reason));
  if (ci.state === 'pending') parts.push(`CI en cours : ${ci.pending.join(', ')}`);
  return {
    kind: 'hold',
    label: s.labeled ? null : 'add',
    draft: s.draft ? null : 'to-draft',
    request,
    note,
    review: r,
    // A run that dies during the relay's review leaves the sweep to start it again.
    awaiting:
      r.kind === 'waiting' ||
      r.kind === 'grace' ||
      r.kind === 'relaying' ||
      (r.kind === 'lovable' && !authorMustAct) ||
      (ci.state === 'pending' && ci.statusPending),
    // While another run has the relay review the head, its status is the lock other runs read, stamped
    // with its time: left as it is, or a red CI rewritten as a failure would hide the review in flight.
    status:
      r.kind === 'relaying'
        ? null
        : { state: authorMustAct ? 'failure' : 'pending', description: clip(`Gardée en brouillon — ${parts.join(' · ')}`) },
  };
}

/** The gate has the relay review now: the head is held for it, and nothing is for the author to fix first. */
export function wantsLovable(s: Snapshot, ci: Ci, plan: Plan): plan is Plan & { review: { kind: 'lovable'; reason: Unreviewed } } {
  return plan.kind === 'hold' && plan.review.kind === 'lovable' && s.unresolvedThreads === 0 && ci.state !== 'red';
}
