import { HttpError, sleep, type Api, type Response } from './github.ts';
import {
  AWAIT_PREFIX,
  CONTEXT,
  LABEL,
  NOTE_MARK,
  REGISTER_WAIT_S,
  type Config,
  type LovableFailure,
  type Quota,
  type ReviewEffort,
  type Snapshot,
  type Unreviewed,
} from './model.ts';
import type { Relay } from './relay.ts';
import { reviewWithLovable, type LovableOutcome, type ReviewOptions } from './review.ts';
import { readQueue, readQuota, readSnapshot } from './snapshot.ts';
import { ciVerdict, decide, LOVABLE_REASONS, REASONS, reviewState, wantsLovable, wantsRequest, type Plan, type Status } from './verdict.ts';

const TO_DRAFT = `mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){clientMutationId}}`;
const TO_READY = `mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){clientMutationId}}`;
const ADD_COMMENT = `mutation($id:ID!,$body:String!){addComment(input:{subjectId:$id,body:$body}){clientMutationId}}`;
const EDIT_COMMENT = `mutation($id:ID!,$body:String!){updateIssueComment(input:{id:$id,body:$body}){clientMutationId}}`;

interface RequestAnswer {
  message?: string;
  failure_reason?: string;
}

interface Failure {
  reason: Unreviewed;
  /** What the run's line says: the status and GitHub's reason, or that the queue never showed it. */
  detail: string;
}

/**
 * Ask Copilot at `effort`, then confirm the request reached its queue. The effort travels with each
 * request: one that names none pays the account's default, which GitHub turned to Balanced on
 * 2026-09-28 (69 of the 73 reviews Copilot left on the gated repositories from 1 to 19 November 2026
 * say "Review effort: Balanced").
 * Returns why the request yielded nothing, or `null` once Copilot has it.
 */
async function requestCopilot(gh: Api, s: Snapshot, effort: ReviewEffort, waitS: number): Promise<Failure | null> {
  let res: Response<RequestAnswer | null>;
  try {
    res = await gh.rest<RequestAnswer | null>('POST', gh.repoPath(`/pulls/${s.number}/copilot-code-review`), { review_effort: effort });
  } catch (err) {
    // A client error (no credits, ineligible repository or actor) is GitHub's refusal: the pull
    // request opens unreviewed. An outage or a rate limit throws on, and the next run asks again.
    if (err instanceof HttpError && !err.transient) return { reason: 'refused', detail: `refusée, ${err.status}` };
    throw err;
  }
  if (res.status === 422 && res.data?.failure_reason === 'INVALID_REVIEW_EFFORT') {
    throw new Error(`copilot-effort « ${effort} » refusé par GitHub : ${res.data.message ?? ''}`);
  }
  // 201 accepted, 409 a request already pending — which stands for the gate's own only if Copilot's
  // queue shows it: a stale one would otherwise keep the pull request waiting with no timeout.
  if (res.status !== 201 && res.status !== 409) {
    return { reason: 'refused', detail: `refusée, ${res.status}${res.data?.failure_reason ? ` ${res.data.failure_reason}` : ''}` };
  }
  // It still has to show up in the queue: Copilot without credits used to take a request and drop
  // it without a trace — no queue entry, no event, no review.
  const deadline = Date.now() + waitS * 1_000;
  for (;;) {
    const q = await readQueue(gh, s.number);
    if (q.queued || q.reviews > s.copilotReviews.length) return null;
    if (Date.now() >= deadline) return { reason: 'ignored', detail: res.status === 409 ? 'en attente hors file' : 'ignorée' };
    await sleep(4_000);
  }
}

export function noteBody(head: string, reason: Unreviewed, quota: Quota | null, lovable: LovableFailure | null = null): string {
  const reset = (reason === 'quota' || reason === 'overage') && quota?.resetAt ? ` (remise à zéro le ${quota.resetAt.slice(0, 10)})` : '';
  return [
    `${NOTE_MARK} head=${head} reason=${reason}${lovable ? ` lovable=${lovable}` : ''} -->`,
    `**Pas de revue Copilot sur \`${head.slice(0, 7)}\`** : ${REASONS[reason]}${reset}.`,
    ...(lovable ? ['', `**Ni de relecture Lovable** : ${LOVABLE_REASONS[lovable]}.`] : []),
    '',
    'La porte ouvre la PR sans cette revue dès que la CI est verte et qu’aucun fil n’est ouvert. La relecture de ce commit reste à faire.',
  ].join('\n');
}

async function setStatus(gh: Api, sha: string, status: Status, runUrl: string): Promise<void> {
  await gh.rest('POST', gh.repoPath(`/statuses/${sha}`), { ...status, context: CONTEXT, target_url: runUrl });
}

async function syncAwait(gh: Api, s: Snapshot, awaiting: boolean): Promise<void> {
  const name = `${AWAIT_PREFIX}${s.number}`;
  if (!awaiting) {
    await gh.rest('DELETE', gh.repoPath(`/actions/variables/${name}`));
    return;
  }
  const res = await gh.rest('PATCH', gh.repoPath(`/actions/variables/${name}`), { name, value: s.head });
  if (res.status === 404) await gh.rest('POST', gh.repoPath('/actions/variables'), { name, value: s.head });
}

/** `restamp`: write the status even when it reads the same, so that its time is now (the relay's lock). */
async function apply(gh: Api, s: Snapshot, plan: Plan, quota: Quota | null, runUrl: string, restamp = false): Promise<void> {
  try {
    // Holding: the label goes on before the draft, so a run that dies in between leaves a pull
    // request the gate still recognizes. Opening: ready first, then the label comes off.
    if (plan.label === 'add') await gh.rest('POST', gh.repoPath(`/issues/${s.number}/labels`), { labels: [LABEL] });
    if (plan.draft === 'to-draft') await gh.graphql(TO_DRAFT, { id: s.id });
    if (plan.draft === 'to-ready') await gh.graphql(TO_READY, { id: s.id });
    if (plan.label === 'remove') await gh.rest('DELETE', gh.repoPath(`/issues/${s.number}/labels/${LABEL}`));
    if (plan.note) {
      const body = noteBody(s.head, plan.note.reason, quota, plan.note.lovable);
      if (s.note) await gh.graphql(EDIT_COMMENT, { id: s.note.id, body });
      else await gh.graphql(ADD_COMMENT, { id: s.id, body });
    }
    const current = s.gateStatus;
    if (plan.status && (restamp || current?.state !== plan.status.state || current.description !== plan.status.description)) {
      await setStatus(gh, s.head, plan.status, runUrl);
    }
    await syncAwait(gh, s, plan.awaiting);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A run that only watches another run's review leaves the status alone even here: it is that review's
    // lock, and a failure written over it would let a later run start a second paid review meanwhile.
    if (plan.review.kind !== 'relaying') {
      await setStatus(gh, s.head, { state: 'failure', description: `La porte n’a pas pu agir : ${message}`.slice(0, 140) }, runUrl).catch(
        () => undefined,
      );
    }
    throw err;
  }
}

export interface Options {
  now?: Date;
  /** How long a request gets to reach Copilot's queue. */
  registerWaitS?: number;
  /** The Lovable relay, when the caller handed over its secrets: it reviews whatever head Copilot cannot. */
  relay?: Relay;
  /** Passed to the relay's review: its clock, its log of each call, its limits. */
  review?: ReviewOptions;
  /**
   * Shared by the pull requests of one run: the relay reviews one of them at most, as a review takes
   * minutes and the job's timeout is 20. The others stay held and awaited for a later run.
   */
  relayTurn?: { taken: boolean };
}

/**
 * Read the pull request, decide, act. Returns the line the run logs. Where Copilot cannot review and the
 * relay can, the run holds the pull request, has the relay review it — minutes, not seconds — and
 * decides again on what that review left: its threads, or the relay's failure.
 */
export async function gatePullRequest(gh: Api, number: number, cfg: Config, runUrl: string, opts: Options = {}): Promise<string> {
  let s = await readSnapshot(gh, number);
  if (!s) return `#${number} — introuvable`;
  const now = opts.now ?? new Date();
  const lovable = cfg.lovable && opts.relay !== undefined;
  const relayFree = !opts.relayTurn?.taken;
  let ci = ciVerdict(s.checks, cfg);
  const review = reviewState(s, cfg, now);
  const quota = wantsRequest(s, ci, review) ? await readQuota(gh) : null;
  let plan = decide(s, ci, review, quota, lovable, relayFree);
  let requested = '';
  if (plan.request) {
    const failure = await requestCopilot(gh, s, cfg.copilotEffort, opts.registerWaitS ?? REGISTER_WAIT_S);
    requested = failure === null ? ` · Copilot demandé (${cfg.copilotEffort})` : ` · demande ${failure.detail}`;
    if (failure !== null) plan = decide(s, ci, { kind: 'unreviewed', reason: failure.reason, lovable: null }, quota, lovable, relayFree);
  }
  let reviewed = '';
  if (opts.relay && relayFree && wantsLovable(s, ci, plan)) {
    if (opts.relayTurn) opts.relayTurn.taken = true;
    // Said before the minutes the review takes: the pull request is held, and the status names the
    // relay — written again even when it reads the same, as its time is what other runs judge it by.
    await apply(gh, s, plan, quota, runUrl, true);
    const reason = plan.review.reason;
    let outcome: LovableOutcome;
    try {
      outcome = await reviewWithLovable(gh, opts.relay, { number, head: s.head, why: REASONS[reason] }, opts.review);
    } catch (err) {
      // GitHub out, unreachable or throttling passes: the run fails, and once its status is past the
      // lock's 20 minutes the next run reviews again. Anything else — a review GitHub refuses, or a bug —
      // is decided on, or the pull request would stay held with a wake-up that starts the whole paid
      // review again, and again.
      if (err instanceof HttpError && err.transient) throw err;
      const message = err instanceof Error ? err.message : String(err);
      outcome = { kind: 'failed', failure: 'unavailable', threads: 0, line: `relecture Lovable en échec : ${message}` };
    }
    if (outcome.kind === 'moved') return `#${number} ${s.head.slice(0, 7)} — la tête a bougé pendant la relecture, rien n’est posté : le run de la nouvelle tête décidera`;
    reviewed = ` · ${outcome.line}`;
    // Minutes went by: the CI, the threads and the head may have moved. Decide on the pull request as it
    // is now, with what the review left — counted even when GitHub's read lags behind the post.
    const fresh = await readSnapshot(gh, number);
    if (!fresh) return `#${number} — introuvable`;
    if (fresh.head !== s.head) return `#${number} ${s.head.slice(0, 7)} — ${outcome.line} · la tête a bougé depuis : son run décidera`;
    ci = ciVerdict(fresh.checks, cfg);
    if (outcome.kind === 'reviewed') {
      s = {
        ...fresh,
        lovableReview: fresh.lovableReview ?? { commit: s.head, submittedAt: now.toISOString() },
        unresolvedThreads: Math.max(fresh.unresolvedThreads, outcome.threads),
      };
      plan = decide(s, ci, reviewState(s, cfg, now), quota, lovable);
    } else {
      // An interrupted review may have posted what it had found, as information. A Copilot review that
      // landed meanwhile is the pull request's review: no note says there was none.
      s = { ...fresh, unresolvedThreads: Math.max(fresh.unresolvedThreads, outcome.threads) };
      const current = reviewState(s, cfg, now);
      plan = decide(s, ci, current.kind === 'done' ? current : { kind: 'unreviewed', reason, lovable: outcome.failure }, quota, lovable);
    }
  }
  await apply(gh, s, plan, quota, runUrl);
  const facts = `CI ${ci.state} · ${s.unresolvedThreads} fil(s) · revue ${review.kind}${quota ? ` · quota ${quota.remaining ?? '?'}${quota.overageRemaining === null ? '' : ` (overage ${quota.overageRemaining})`}` : ''}`;
  return `#${number} ${s.head.slice(0, 7)} — ${facts}${requested}${reviewed} → ${plan.kind}${plan.status ? ` : ${plan.status.description}` : ''}`;
}
