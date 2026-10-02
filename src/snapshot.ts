import type { Api } from './github.ts';
import {
  CONTEXT,
  COPILOT_LOGIN,
  LABEL,
  NOTE_MARK,
  type Check,
  type Note,
  type Quota,
  type Snapshot,
  type Unreviewed,
} from './model.ts';

/** Everything the gate decides on, in one read. */
export const SNAPSHOT_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      id number state isDraft headRefOid
      labels(first:50){nodes{name}}
      reviewRequests(first:30){nodes{requestedReviewer{__typename ... on Bot{login}}}}
      reviews(last:50,author:"${COPILOT_LOGIN}[bot]",states:[COMMENTED,APPROVED,CHANGES_REQUESTED]){nodes{submittedAt commit{oid} comments{totalCount}}}
      reviewThreads(first:100){pageInfo{hasNextPage endCursor} nodes{isResolved}}
      timelineItems(last:100,itemTypes:[REVIEW_REQUESTED_EVENT,LABELED_EVENT]){nodes{__typename
        ... on ReviewRequestedEvent{createdAt requestedReviewer{__typename ... on Bot{login}}}
        ... on LabeledEvent{createdAt label{name}}}}
      comments(last:100){nodes{id body}}
      commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100){nodes{__typename
        ... on CheckRun{name status conclusion startedAt completedAt checkSuite{workflowRun{workflow{name}}}}
        ... on StatusContext{context state description createdAt}}}}}}}
    }
  }
}`;

const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{isResolved}}
    }
  }
}`;

const QUEUE_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviewRequests(first:30){nodes{requestedReviewer{__typename ... on Bot{login}}}}
      reviews(author:"${COPILOT_LOGIN}[bot]",states:[COMMENTED,APPROVED,CHANGES_REQUESTED]){totalCount}
    }
  }
}`;

interface Page<T> {
  nodes: (T | null)[];
}
interface Threads extends Page<{ isResolved: boolean }> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}
type Reviewer = { __typename: string; login?: string } | null;

type Context =
  | {
      __typename: 'CheckRun';
      name: string;
      status: string;
      conclusion: string | null;
      startedAt: string | null;
      completedAt: string | null;
      checkSuite: { workflowRun: { workflow: { name: string } | null } | null } | null;
    }
  | { __typename: 'StatusContext'; context: string; state: string; description: string | null; createdAt: string };

export interface RawPullRequest {
  id: string;
  number: number;
  state: string;
  isDraft: boolean;
  headRefOid: string;
  labels: Page<{ name: string }>;
  reviewRequests: Page<{ requestedReviewer: Reviewer }>;
  reviews: Page<{ submittedAt: string | null; commit: { oid: string } | null; comments: { totalCount: number } }>;
  reviewThreads: Threads;
  timelineItems: Page<{
    __typename: string;
    createdAt?: string;
    requestedReviewer?: Reviewer;
    label?: { name: string } | null;
  }>;
  comments: Page<{ id: string; body: string }>;
  commits: Page<{ commit: { oid: string; statusCheckRollup: { contexts: Page<Context> } | null } }>;
}

const present = <T>(nodes: (T | null)[]): T[] => nodes.filter((n): n is T => n !== null);

/** A queued check sorts after every started one: it is the newest run of its name. */
const NOT_STARTED = '￿';

function toCheck(c: Context): Check {
  if (c.__typename === 'StatusContext') {
    const state =
      c.state === 'SUCCESS'
        ? 'success'
        : c.state === 'PENDING' || c.state === 'EXPECTED'
          ? 'pending'
          : // A superseded deployment (Railway reaps the first of two deploys of one commit) says nothing about the code.
            /cancel/i.test(c.description ?? '')
            ? 'ignored'
            : 'failure';
    return { workflow: '', name: c.context, state, at: c.createdAt };
  }
  const workflow = c.checkSuite?.workflowRun?.workflow?.name ?? '';
  if (c.status !== 'COMPLETED') return { workflow, name: c.name, state: 'pending', at: c.startedAt ?? NOT_STARTED };
  const state =
    c.conclusion === 'SUCCESS' || c.conclusion === 'NEUTRAL' || c.conclusion === 'SKIPPED'
      ? 'success'
      : c.conclusion === 'STALE'
        ? 'ignored'
        : 'failure';
  return { workflow, name: c.name, state, at: c.startedAt ?? c.completedAt ?? '' };
}

const NOTE_FIELDS = /head=([0-9a-f]{40}) reason=(quota|ignored|timeout)/;

function toNote(comment: { id: string; body: string }): Note | null {
  if (!comment.body.startsWith(NOTE_MARK)) return null;
  const m = NOTE_FIELDS.exec(comment.body);
  return m?.[1] && m[2] ? { id: comment.id, head: m[1], reason: m[2] as Unreviewed } : null;
}

const isCopilot = (r: Reviewer | undefined) => r?.__typename === 'Bot' && r.login === COPILOT_LOGIN;

/** The pull request as the gate sees it. `unresolvedThreads` counts the first page; `readSnapshot` adds the rest. */
export function parseSnapshot(pr: RawPullRequest): Snapshot {
  const timeline = present(pr.timelineItems.nodes);
  const latest = (times: (string | undefined)[]) => times.filter((t): t is string => !!t).sort().at(-1) ?? null;
  const commit = present(pr.commits.nodes)[0]?.commit;
  const contexts = present(commit?.statusCheckRollup?.contexts.nodes ?? []);
  const gate = contexts.find((c) => c.__typename === 'StatusContext' && c.context === CONTEXT);
  const notes = present(pr.comments.nodes).map(toNote).filter((n): n is Note => n !== null);
  return {
    id: pr.id,
    number: pr.number,
    open: pr.state === 'OPEN',
    draft: pr.isDraft,
    head: pr.headRefOid,
    labeled: present(pr.labels.nodes).some((l) => l.name === LABEL),
    labeledAt: latest(timeline.filter((t) => t.__typename === 'LabeledEvent' && t.label?.name === LABEL).map((t) => t.createdAt)),
    copilotQueued: present(pr.reviewRequests.nodes).some((r) => isCopilot(r.requestedReviewer)),
    copilotRequestedAt: latest(
      timeline.filter((t) => t.__typename === 'ReviewRequestedEvent' && isCopilot(t.requestedReviewer)).map((t) => t.createdAt),
    ),
    copilotReviews: present(pr.reviews.nodes)
      .filter((r) => r.submittedAt && r.commit)
      .map((r) => ({ commit: r.commit!.oid, submittedAt: r.submittedAt!, comments: r.comments.totalCount }))
      .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt)),
    unresolvedThreads: present(pr.reviewThreads.nodes).filter((t) => !t.isResolved).length,
    checks: contexts.map(toCheck),
    gateStatus: gate?.__typename === 'StatusContext' ? { state: gate.state.toLowerCase(), description: gate.description ?? '' } : null,
    note: notes.at(-1) ?? null,
  };
}

export async function readSnapshot(gh: Api, number: number): Promise<Snapshot | null> {
  const vars = { owner: gh.owner, name: gh.repo, number };
  const data = await gh.graphql<{ repository: { pullRequest: RawPullRequest | null } }>(SNAPSHOT_QUERY, vars);
  const pr = data.repository.pullRequest;
  if (!pr) return null;
  const snapshot = parseSnapshot(pr);
  let page = pr.reviewThreads.pageInfo;
  while (page.hasNextPage && page.endCursor) {
    const more = await gh.graphql<{ repository: { pullRequest: { reviewThreads: Threads } } }>(THREADS_QUERY, {
      ...vars,
      after: page.endCursor,
    });
    const threads = more.repository.pullRequest.reviewThreads;
    snapshot.unresolvedThreads += present(threads.nodes).filter((t) => !t.isResolved).length;
    page = threads.pageInfo;
  }
  return snapshot;
}

/** Whether Copilot is queued now, and how many reviews it has submitted. */
export async function readQueue(gh: Api, number: number): Promise<{ queued: boolean; reviews: number }> {
  const data = await gh.graphql<{
    repository: { pullRequest: { reviewRequests: Page<{ requestedReviewer: Reviewer }>; reviews: { totalCount: number } } };
  }>(QUEUE_QUERY, { owner: gh.owner, name: gh.repo, number });
  const pr = data.repository.pullRequest;
  return {
    queued: present(pr.reviewRequests.nodes).some((r) => isCopilot(r.requestedReviewer)),
    reviews: pr.reviews.totalCount,
  };
}

interface RawQuota {
  quota_reset_date_utc?: string;
  quota_reset_date?: string;
  quota_snapshots?: {
    premium_interactions?: { has_quota?: boolean; remaining?: number; unlimited?: boolean };
  };
}

/**
 * The token owner's Copilot premium-request quota. The endpoint is undocumented: an answer it does not
 * give, or gives in another shape, reads as unknown — and an unknown quota never stops a request.
 */
export function parseQuota(raw: RawQuota): Quota | null {
  const q = raw.quota_snapshots?.premium_interactions;
  if (!q || (q.has_quota === undefined && q.remaining === undefined)) return null;
  const remaining = typeof q.remaining === 'number' ? q.remaining : null;
  const exhausted = !q.unlimited && (q.has_quota === false || (remaining !== null && remaining <= 0));
  return { exhausted, remaining, resetAt: raw.quota_reset_date_utc ?? raw.quota_reset_date ?? null };
}

export async function readQuota(gh: Api): Promise<Quota | null> {
  try {
    const res = await gh.rest<RawQuota>('GET', '/copilot_internal/user');
    return res.status === 200 && res.data ? parseQuota(res.data) : null;
  } catch {
    return null;
  }
}
