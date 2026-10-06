import {
  CONTEXT,
  COPILOT_LOGIN,
  COPILOT_TIMEOUT_MIN,
  COPILOT_WORKFLOW,
  RULESET_GRACE_MIN,
  type Check,
  type Config,
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
  /** No review is due, or the due one came in. */
  | { kind: 'done' }
  /** A review is due and nobody asked for it. */
  | { kind: 'due' }
  /** Copilot is queued. */
  | { kind: 'waiting' }
  /** `first-review: ruleset` — the ruleset still has time to request the first review. */
  | { kind: 'grace' }
  /** Copilot cannot review this head: the gate opens without it, and says so. */
  | { kind: 'unreviewed'; reason: Unreviewed };

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
  /** Record that this head goes without a Copilot review, and why. */
  note: Unreviewed | null;
  /**
   * Keep the variable that wakes the scheduled sweep. Copilot's review raises no event the gate can run on,
   * and neither does a commit status such as a deployment's.
   */
  awaiting: boolean;
}

export const REASONS: Record<Unreviewed, string> = {
  quota: 'crédits Copilot épuisés',
  ignored: 'demande ignorée par Copilot (quota ou panne)',
  timeout: `Copilot n’a pas rendu sa revue en ${COPILOT_TIMEOUT_MIN} min`,
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

/** The CI verdict on the head, the gate's and Copilot's own checks left out. */
export function ciVerdict(checks: readonly Check[], cfg: Config): Ci {
  const latest = new Map<string, Check>();
  for (const c of checks) {
    if (excluded(c, cfg)) continue;
    const key = `${c.workflow}\u0000${c.name}`;
    const seen = latest.get(key);
    if (!seen || c.at > seen.at) latest.set(key, c);
  }
  const kept = [...latest.values()].filter((c) => c.state !== 'ignored');
  const failing = kept.filter((c) => c.state === 'failure').map((c) => c.name);
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
 * Where the head stands with Copilot. Copilot reviews a pull request once: a review is due only while the
 * pull request has none. Every later push, those answering its threads included, costs no review.
 */
export function reviewState(s: Snapshot, cfg: Config, now: Date): Review {
  const last = s.copilotReviews.at(-1);
  const due = !last;
  if (s.copilotQueued) {
    const since = s.copilotRequestedAt ?? s.labeledAt;
    if (since && minutesSince(since, now) >= COPILOT_TIMEOUT_MIN) {
      return due ? { kind: 'unreviewed', reason: 'timeout' } : { kind: 'done' };
    }
    return { kind: 'waiting' };
  }
  if (!due) return { kind: 'done' };
  if (s.note?.head === s.head) return { kind: 'unreviewed', reason: s.note.reason };
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
 * unknown, and an unknown quota never stops a request.
 */
export function decide(s: Snapshot, ci: Ci, review: Review, quota: Quota | null): Plan {
  const nothing = { label: null, draft: null, request: false, note: null, awaiting: false } as const;
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
    if (quota?.exhausted) r = { kind: 'unreviewed', reason: 'quota' };
    else {
      request = true;
      r = { kind: 'waiting' };
    }
  }
  const note = r.kind === 'unreviewed' && (s.note?.head !== s.head || s.note.reason !== r.reason) ? r.reason : null;

  if (ci.state === 'green' && s.unresolvedThreads === 0 && (r.kind === 'done' || r.kind === 'unreviewed')) {
    return {
      kind: 'open',
      label: s.labeled ? 'remove' : null,
      draft: s.draft ? 'to-ready' : null,
      request: false,
      note,
      awaiting: false,
      status:
        r.kind === 'unreviewed'
          ? { state: 'success', description: clip(`Prête — NON relue par Copilot : ${REASONS[r.reason]}`) }
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
  if (ci.state === 'pending') parts.push(`CI en cours : ${ci.pending.join(', ')}`);
  return {
    kind: 'hold',
    label: s.labeled ? null : 'add',
    draft: s.draft ? null : 'to-draft',
    request,
    note,
    awaiting: r.kind === 'waiting' || r.kind === 'grace' || (ci.state === 'pending' && ci.statusPending),
    status: { state: authorMustAct ? 'failure' : 'pending', description: clip(`Gardée en brouillon — ${parts.join(' · ')}`) },
  };
}
