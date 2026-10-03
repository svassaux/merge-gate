import { sleep, type Api } from './github.ts';
import {
  AWAIT_PREFIX,
  CONTEXT,
  COPILOT_BOT_ID,
  LABEL,
  NOTE_MARK,
  REGISTER_WAIT_S,
  type Config,
  type Quota,
  type Snapshot,
  type Unreviewed,
} from './model.ts';
import { readQueue, readQuota, readSnapshot } from './snapshot.ts';
import { ciVerdict, decide, REASONS, reviewState, wantsRequest, type Plan, type Status } from './verdict.ts';

const REQUEST = `mutation($pr:ID!,$bot:ID!){requestReviews(input:{pullRequestId:$pr,botIds:[$bot],union:true}){clientMutationId}}`;
const TO_DRAFT = `mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){clientMutationId}}`;
const TO_READY = `mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){clientMutationId}}`;
const ADD_COMMENT = `mutation($id:ID!,$body:String!){addComment(input:{subjectId:$id,body:$body}){clientMutationId}}`;
const EDIT_COMMENT = `mutation($id:ID!,$body:String!){updateIssueComment(input:{id:$id,body:$body}){clientMutationId}}`;

/**
 * Ask Copilot, then confirm the request reached its queue. Copilot without credits takes the request
 * and drops it without a trace: no queue entry, no event, no review.
 */
async function requestCopilot(gh: Api, s: Snapshot, waitS: number): Promise<boolean> {
  await gh.graphql(REQUEST, { pr: s.id, bot: COPILOT_BOT_ID });
  const deadline = Date.now() + waitS * 1_000;
  for (;;) {
    const q = await readQueue(gh, s.number);
    if (q.queued || q.reviews > s.copilotReviews.length) return true;
    if (Date.now() >= deadline) return false;
    await sleep(4_000);
  }
}

export function noteBody(head: string, reason: Unreviewed, quota: Quota | null): string {
  const reset = reason === 'quota' && quota?.resetAt ? ` (remise à zéro le ${quota.resetAt.slice(0, 10)})` : '';
  return [
    `${NOTE_MARK} head=${head} reason=${reason} -->`,
    `**Pas de revue Copilot sur \`${head.slice(0, 7)}\`** : ${REASONS[reason]}${reset}.`,
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

async function apply(gh: Api, s: Snapshot, plan: Plan, quota: Quota | null, runUrl: string): Promise<void> {
  try {
    // Holding: the label goes on before the draft, so a run that dies in between leaves a pull
    // request the gate still recognizes. Opening: ready first, then the label comes off.
    if (plan.label === 'add') await gh.rest('POST', gh.repoPath(`/issues/${s.number}/labels`), { labels: [LABEL] });
    if (plan.draft === 'to-draft') await gh.graphql(TO_DRAFT, { id: s.id });
    if (plan.draft === 'to-ready') await gh.graphql(TO_READY, { id: s.id });
    if (plan.label === 'remove') await gh.rest('DELETE', gh.repoPath(`/issues/${s.number}/labels/${LABEL}`));
    if (plan.note) {
      const body = noteBody(s.head, plan.note, quota);
      if (s.note) await gh.graphql(EDIT_COMMENT, { id: s.note.id, body });
      else await gh.graphql(ADD_COMMENT, { id: s.id, body });
    }
    const current = s.gateStatus;
    if (plan.status && (current?.state !== plan.status.state || current.description !== plan.status.description)) {
      await setStatus(gh, s.head, plan.status, runUrl);
    }
    await syncAwait(gh, s, plan.awaiting);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setStatus(gh, s.head, { state: 'failure', description: `La porte n’a pas pu agir : ${message}`.slice(0, 140) }, runUrl).catch(
      () => undefined,
    );
    throw err;
  }
}

export interface Options {
  now?: Date;
  /** How long a request gets to reach Copilot's queue. */
  registerWaitS?: number;
}

/** Read the pull request, decide, act. Returns the line the run logs. */
export async function gatePullRequest(gh: Api, number: number, cfg: Config, runUrl: string, opts: Options = {}): Promise<string> {
  const s = await readSnapshot(gh, number);
  if (!s) return `#${number} — introuvable`;
  const ci = ciVerdict(s.checks, cfg);
  const review = reviewState(s, cfg, opts.now ?? new Date());
  const quota = wantsRequest(s, ci, review) ? await readQuota(gh) : null;
  let plan = decide(s, ci, review, quota);
  let requested = '';
  if (plan.request) {
    const registered = await requestCopilot(gh, s, opts.registerWaitS ?? REGISTER_WAIT_S);
    requested = registered ? ' · Copilot demandé' : ' · demande ignorée';
    if (!registered) plan = decide(s, ci, { kind: 'unreviewed', reason: 'ignored' }, quota);
  }
  await apply(gh, s, plan, quota, runUrl);
  const facts = `CI ${ci.state} · ${s.unresolvedThreads} fil(s) · revue ${review.kind}${quota ? ` · quota ${quota.remaining ?? '?'}${quota.overageRemaining === null ? '' : ` (overage ${quota.overageRemaining})`}` : ''}`;
  return `#${number} ${s.head.slice(0, 7)} — ${facts}${requested} → ${plan.kind}${plan.status ? ` : ${plan.status.description}` : ''}`;
}
