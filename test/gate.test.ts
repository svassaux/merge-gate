import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { gatePullRequest, noteBody } from '../src/gate.ts';
import { HttpError, isThrottled, type Api, type Response } from '../src/github.ts';
import { REVIEW_EFFORTS, type Unreviewed } from '../src/model.ts';
import { SNAPSHOT_QUERY, type RawPullRequest } from '../src/snapshot.ts';
import { targets } from '../src/targets.ts';
import { REASONS } from '../src/verdict.ts';
import { cfg, NOW } from './helpers.ts';

type Call = string;

/** The request for Copilot's review of #77, with the effort it names. */
const ASK = 'POST /pulls/77/copilot-code-review lite';
/** GitHub's answer to a request naming an effort it does not offer, recorded on 2026-11-19. */
const INVALID_EFFORT = {
  message: 'The requested review effort is not available for this pull request. Available review efforts: adaptive, lite, balanced, max.',
  failure_reason: 'INVALID_REVIEW_EFFORT',
};

/** A GitHub that answers from a recorded pull request and records every write, in order. */
class FakeGitHub implements Api {
  readonly owner = 'svassaux';
  readonly repo = 'demo';
  readonly calls: Call[] = [];
  /** The body of the last note the gate wrote. */
  note = '';
  queueAfterRequest = true;
  requestAnswer: Response<unknown> = { status: 201, data: { node_id: 'CCR_1', state: 'PENDING' } };
  requestHeaders = new Headers();
  quota: object | null = { quota_snapshots: { premium_interactions: { has_quota: true, remaining: 900 } } };
  failOn: string | null = null;
  variableExists = false;
  readonly pr: RawPullRequest;

  constructor(pr: RawPullRequest) {
    this.pr = pr;
  }

  repoPath(path: string): string {
    return `/repos/${this.owner}/${this.repo}${path}`;
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    if (query === SNAPSHOT_QUERY) return { repository: { pullRequest: this.pr } } as T;
    if (query.includes('reviewRequests(first:30)') && query.includes('totalCount')) {
      // Accepted, or already pending: either way the queue shows it unless Copilot dropped it.
      const queued = this.calls.includes(ASK) && [201, 409].includes(this.requestAnswer.status) && this.queueAfterRequest;
      return {
        repository: {
          pullRequest: {
            reviewRequests: { nodes: queued ? [{ requestedReviewer: { __typename: 'Bot', login: 'copilot-pull-request-reviewer' } }] : [] },
            reviews: { totalCount: this.pr.reviews.nodes.length },
          },
        },
      } as T;
    }
    const name = /\{(\w+)\(input/.exec(query)?.[1] ?? 'graphql?';
    if (name === this.failOn) throw new Error(`${name} refused`);
    this.calls.push(name);
    if (name === 'addComment' || name === 'updateIssueComment') this.note = String(variables['body']);
    return {} as T;
  }

  async rest<T>(method: string, path: string, body?: unknown): Promise<Response<T>> {
    const short = `${method} ${path.replace(this.repoPath(''), '')}`;
    if (short === 'GET /copilot_internal/user') return { status: this.quota ? 200 : 404, data: this.quota as T };
    if (short.startsWith(this.failOn ?? '\0')) throw new Error(`${short} refused`);
    const effort = (body as { review_effort?: string } | undefined)?.review_effort;
    if (short.endsWith('/copilot-code-review')) {
      this.calls.push(`${short} ${effort}`);
      // As the real client: any status outside 404, 409 and 422 at 400 or above throws.
      const { status } = this.requestAnswer;
      if (status >= 400 && ![404, 409, 422].includes(status)) {
        const message = (this.requestAnswer.data as { message?: string } | null)?.message ?? '';
        throw new HttpError(status, `${short}: ${status} ${message}`, isThrottled(status, this.requestHeaders, message));
      }
      return this.requestAnswer as Response<T>;
    }
    const state = (body as { state?: string } | undefined)?.state;
    this.calls.push(state ? `${short} ${state}` : short);
    if (method === 'PATCH' && path.includes('/actions/variables/')) return { status: this.variableExists ? 204 : 404, data: null as T };
    return { status: 201, data: null as T };
  }
}

const recorded = () =>
  JSON.parse(readFileSync(new URL('./fixtures/garmlink-77.json', import.meta.url), 'utf8')) as RawPullRequest;

/** garmlink #77 without its reviews: a ready pull request Copilot never reviewed, CI green. */
function unreviewed(): RawPullRequest {
  const pr = recorded();
  pr.reviews.nodes = [];
  return pr;
}

const RUN = 'https://github.com/svassaux/demo/actions/runs/1';
const gate = (gh: FakeGitHub) => gatePullRequest(gh, 77, cfg, RUN, { now: NOW, registerWaitS: 0 });

describe('acting on a pull request', () => {
  it('on a hand-over: labels it, then draws it back to draft, asks Copilot, says why and keeps a wake-up', async () => {
    const gh = new FakeGitHub(unreviewed());
    await gate(gh);
    assert.deepEqual(gh.calls, [
      ASK,
      'POST /issues/77/labels',
      'convertPullRequestToDraft',
      'POST /statuses/' + gh.pr.headRefOid + ' pending',
      'PATCH /actions/variables/MERGE_GATE_AWAIT_77',
      'POST /actions/variables',
    ]);
  });

  it('asks nothing after a push that answered the review\'s threads — Copilot reviews a pull request once', async () => {
    const pr = recorded(); // one Copilot review that opened a thread, since resolved
    pr.reviews.nodes = pr.reviews.nodes.map((r) => r && { ...r, commit: { oid: 'a'.repeat(40) } });
    const gh = new FakeGitHub(pr);
    await gate(gh);
    assert.ok(!gh.calls.includes(ASK));
    assert.ok(gh.calls.includes('POST /statuses/' + pr.headRefOid + ' success'));
  });

  it('opens without the review when Copilot never queues the request — and leaves a note', async () => {
    const gh = new FakeGitHub(unreviewed());
    gh.queueAfterRequest = false;
    const line = await gate(gh);
    assert.deepEqual(gh.calls, [
      ASK,
      'addComment',
      'POST /statuses/' + gh.pr.headRefOid + ' success',
      'DELETE /actions/variables/MERGE_GATE_AWAIT_77',
    ]);
    assert.match(line, /demande ignorée → open/);
  });

  it('asks nothing when the credits are exhausted, and opens with a note', async () => {
    const gh = new FakeGitHub(unreviewed());
    gh.quota = { quota_snapshots: { premium_interactions: { has_quota: false, remaining: 0 } } };
    const line = await gate(gh);
    assert.ok(!gh.calls.includes(ASK));
    assert.deepEqual(gh.calls.slice(0, 2), ['addComment', 'POST /statuses/' + gh.pr.headRefOid + ' success']);
    // No allowance to report, so the line says nothing about one: printing `(overage null)` would
    // put a number-shaped hole in the only trace of what the gate decided.
    assert.doesNotMatch(line, /overage/);
  });

  it('asks nothing once the overage allowance is spent, and still reports the room in the line', async () => {
    // Synthetic (no spent allowance was ever recorded). Two cases, because the room reported here is
    // the one value that is NOT positive: exactly zero when the counter met the cap, and negative
    // past it — token-based billing lets a single review cost more than what was left. Both have to
    // appear in the line: a reading that prints the room only when it is truthy
    // (`!quota.overageRemaining` instead of `=== null`) stays green on every other test and loses
    // precisely the number that explains why the gate stopped asking.
    for (const [spent, expected] of [
      [{ overage_count: 4000, remaining: -4000 }, /quota -4000 \(overage 0\)/],
      [{ overage_count: 4100, remaining: -4100 }, /quota -4100 \(overage -100\)/],
    ] as [Record<string, number>, RegExp][]) {
      const gh = new FakeGitHub(unreviewed());
      gh.quota = {
        quota_snapshots: {
          premium_interactions: { has_quota: true, overage_permitted: true, overage_entitlement: 4000, unlimited: false, ...spent },
        },
      };
      const line = await gate(gh);
      assert.ok(!gh.calls.includes(ASK), JSON.stringify(spent));
      assert.ok(gh.calls.includes('addComment'), JSON.stringify(spent));
      assert.match(line, expected);
    }
  });

  it('still asks past the included entitlement, on the answer measured on 2026-10-03', async () => {
    // The whole point of reading the overage: this is what the endpoint answered seven minutes after
    // the gate opened loudwear #18 unreviewed on `remaining <= 0`. Nothing is published about the
    // credits here — the pull request waits for the review, and the line says what was left to bill.
    const gh = new FakeGitHub(unreviewed());
    gh.quota = {
      quota_snapshots: {
        premium_interactions: { has_quota: true, remaining: -422, overage_permitted: true, overage_count: 421, overage_entitlement: 4000, unlimited: false },
      },
    };
    const line = await gate(gh);
    assert.ok(gh.calls.includes(ASK));
    assert.ok(!gh.calls.includes('addComment'));
    assert.match(line, /quota -422 \(overage 3579\)/);
  });

  it('takes a request already pending as its own only when Copilot’s queue shows it', async () => {
    const pending = { status: 409, data: { message: 'A Copilot code review request is already pending for this pull request' } };
    const gh = new FakeGitHub(unreviewed());
    gh.requestAnswer = pending;
    const line = await gate(gh);
    assert.ok(!gh.calls.includes('addComment'));
    assert.ok(gh.calls.includes('POST /statuses/' + gh.pr.headRefOid + ' pending'));
    assert.match(line, /Copilot demandé \(lite\)/);
    // A stale pending request never reaches the queue: waiting on it would have no timeout.
    const stale = new FakeGitHub(unreviewed());
    stale.requestAnswer = pending;
    stale.queueAfterRequest = false;
    assert.match(await gate(stale), /demande en attente hors file → open/);
    assert.match(stale.note, /reason=ignored/);
  });

  it('opens with a note when GitHub refuses the request, whether it answers 422 or another client error', async () => {
    // Neither refusal was ever recorded: the failure_reason of a refusal for want of credits is made
    // up, and 403 stands for any client error the real client throws on.
    for (const [answer, expected] of [
      [{ status: 422, data: { message: 'No quota remaining', failure_reason: 'QUOTA_EXHAUSTED' } }, /demande refusée, 422 QUOTA_EXHAUSTED → open/],
      [{ status: 403, data: { message: 'Resource not accessible' } }, /demande refusée, 403 → open/],
    ] as [Response<unknown>, RegExp][]) {
      const gh = new FakeGitHub(unreviewed());
      gh.requestAnswer = answer;
      assert.match(await gate(gh), expected);
      assert.match(gh.note, /reason=refused/);
      assert.match(gh.note, /demande refusée par GitHub/);
    }
  });

  it('reads back every note it writes, so a run after it neither asks again nor adds a second note', async () => {
    const reasons = Object.keys(REASONS) as Unreviewed[];
    assert.ok(reasons.length >= 4);
    for (const reason of reasons) {
      const pr = unreviewed();
      pr.comments.nodes.push({ id: 'IC_note', body: noteBody(pr.headRefOid, reason, null) });
      const gh = new FakeGitHub(pr);
      await gate(gh);
      assert.ok(!gh.calls.includes(ASK), reason);
      assert.ok(!gh.calls.includes('addComment') && !gh.calls.includes('updateIssueComment'), reason);
    }
  });

  it('fails the run on an outage or a rate limit instead of opening the pull request unreviewed', async () => {
    // GitHub's documented rate-limit answers: 429; 403 naming the rate limit, with retry-after
    // (secondary limit) or x-ratelimit-remaining 0 (primary limit). The next run asks again.
    for (const [status, headers, message] of [
      [503, {}, 'Service Unavailable'],
      [429, {}, 'Too Many Requests'],
      [403, {}, 'You have exceeded a secondary rate limit.'],
      // Each header alone, for a body that says nothing.
      [403, { 'retry-after': '60' }, ''],
      [403, { 'x-ratelimit-remaining': '0' }, ''],
    ] as [number, Record<string, string>, string][]) {
      const gh = new FakeGitHub(unreviewed());
      gh.requestAnswer = { status, data: { message } };
      gh.requestHeaders = new Headers(headers);
      await assert.rejects(gate(gh), new RegExp(String(status)));
      assert.ok(!gh.calls.includes('addComment'), String(status));
    }
  });

  it('fails the run on an effort GitHub does not offer, instead of opening the pull request unreviewed', async () => {
    const gh = new FakeGitHub(unreviewed());
    gh.requestAnswer = { status: 422, data: INVALID_EFFORT };
    await assert.rejects(gate(gh), /copilot-effort « lite » refusé par GitHub/);
    assert.deepEqual(gh.calls, [ASK]);
  });

  it('accepts exactly the efforts GitHub offers', () => {
    const offered = /Available review efforts: (.+)\./.exec(INVALID_EFFORT.message)?.[1]?.split(', ') ?? [];
    assert.ok(offered.length > 0, 'the recorded answer lists the efforts');
    assert.deepEqual([...REVIEW_EFFORTS].sort(), offered.sort());
  });

  it('edits its note on a new head instead of adding a second one', async () => {
    const pr = unreviewed();
    pr.comments.nodes.push({ id: 'IC_note', body: `<!-- merge-gate:unreviewed head=${'b'.repeat(40)} reason=quota -->` });
    const gh = new FakeGitHub(pr);
    gh.quota = { quota_snapshots: { premium_interactions: { has_quota: false, remaining: 0 } } };
    await gate(gh);
    assert.ok(gh.calls.includes('updateIssueComment'));
    assert.ok(!gh.calls.includes('addComment'));
  });

  it('when opening a held pull request: ready first, then the label comes off', async () => {
    const pr = recorded();
    pr.isDraft = true;
    pr.labels.nodes.push({ name: 'merge-gate' });
    const gh = new FakeGitHub(pr);
    await gate(gh);
    assert.deepEqual(gh.calls.slice(0, 3), [
      'markPullRequestReadyForReview',
      'DELETE /issues/77/labels/merge-gate',
      'POST /statuses/' + pr.headRefOid + ' success',
    ]);
  });

  it('does not rewrite a status that already says the same', async () => {
    const pr = recorded();
    pr.commits.nodes[0]!.commit.statusCheckRollup!.contexts.nodes.push({
      __typename: 'StatusContext',
      context: 'merge-gate',
      state: 'SUCCESS',
      description: 'Prête — CI verte, relue par Copilot, aucun fil ouvert',
      createdAt: '2026-10-02T10:00:00Z',
    });
    const gh = new FakeGitHub(pr);
    await gate(gh);
    assert.deepEqual(gh.calls, ['DELETE /actions/variables/MERGE_GATE_AWAIT_77']);
  });

  it('updates the wake-up it already has rather than creating it again', async () => {
    const gh = new FakeGitHub(unreviewed());
    gh.variableExists = true;
    await gate(gh);
    assert.equal(gh.calls.at(-1), 'PATCH /actions/variables/MERGE_GATE_AWAIT_77');
  });

  it('says on the head when it cannot draw the pull request back to draft, and fails the run', async () => {
    const pr = recorded();
    pr.reviewThreads.nodes.push({ isResolved: false });
    const gh = new FakeGitHub(pr);
    gh.failOn = 'convertPullRequestToDraft';
    await assert.rejects(gate(gh), /convertPullRequestToDraft refused/);
    assert.equal(gh.calls.at(-1), 'POST /statuses/' + pr.headRefOid + ' failure');
  });
});

describe('the pull requests an event concerns', () => {
  const gh = new FakeGitHub(recorded());
  const restOf = (data: unknown) =>
    Object.assign(Object.create(gh) as FakeGitHub, { rest: async () => ({ status: 200, data }) });

  it('a pull request event: its own', async () => {
    assert.deepEqual(await targets(gh, 'pull_request', { pull_request: { number: 5 } }), [5]);
  });

  it('a finished workflow: the pull requests it lists', async () => {
    const event = { workflow_run: { head_sha: 'x', pull_requests: [{ number: 8 }] } };
    assert.deepEqual(await targets(gh, 'workflow_run', event), [8]);
  });

  it('a finished workflow that lists none: the open pull requests whose head it ran on', async () => {
    const api = restOf([
      { number: 3, state: 'open', head: { sha: 'x' } },
      { number: 4, state: 'closed', head: { sha: 'x' } },
      { number: 6, state: 'open', head: { sha: 'y' } },
    ]);
    assert.deepEqual(await targets(api, 'workflow_run', { workflow_run: { head_sha: 'x', pull_requests: [] } }), [3]);
  });

  it('the sweep: the pull requests waiting on Copilot', async () => {
    // RELEASE_CHANNEL_V2 is as long as the prefix and ends in a number: only the prefix tells them apart.
    const api = restOf({ variables: [{ name: 'MERGE_GATE_AWAIT_12' }, { name: 'RELEASE_CHANNEL_V2' }, { name: 'MERGE_GATE_AWAIT_3' }] });
    assert.deepEqual(await targets(api, 'schedule', {}), [12, 3]);
  });

  it('a manual run: the pull request asked for, or every one the gate keeps', async () => {
    assert.deepEqual(await targets(gh, 'workflow_dispatch', { inputs: { pr: '9' } }), [9]);
    const api = restOf([
      { number: 1, draft: false, labels: [] },
      { number: 2, draft: true, labels: [] },
      { number: 3, draft: true, labels: [{ name: 'merge-gate' }] },
    ]);
    assert.deepEqual(await targets(api, 'workflow_dispatch', { inputs: { pr: '' } }), [1, 3]);
  });
});
