import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { gatePullRequest } from '../src/gate.ts';
import type { Api, Response } from '../src/github.ts';
import { SNAPSHOT_QUERY, type RawPullRequest } from '../src/snapshot.ts';
import { targets } from '../src/targets.ts';
import { cfg, NOW } from './helpers.ts';

type Call = string;

/** A GitHub that answers from a recorded pull request and records every write, in order. */
class FakeGitHub implements Api {
  readonly owner = 'svassaux';
  readonly repo = 'demo';
  readonly calls: Call[] = [];
  queueAfterRequest = true;
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

  async graphql<T>(query: string): Promise<T> {
    if (query === SNAPSHOT_QUERY) return { repository: { pullRequest: this.pr } } as T;
    if (query.includes('reviewRequests(first:30)') && query.includes('totalCount')) {
      const queued = this.calls.includes('requestReviews') && this.queueAfterRequest;
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
    return {} as T;
  }

  async rest<T>(method: string, path: string, body?: unknown): Promise<Response<T>> {
    const short = `${method} ${path.replace(this.repoPath(''), '')}`;
    if (short === 'GET /copilot_internal/user') return { status: this.quota ? 200 : 404, data: this.quota as T };
    if (short.startsWith(this.failOn ?? '\0')) throw new Error(`${short} refused`);
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
      'requestReviews',
      'POST /issues/77/labels',
      'convertPullRequestToDraft',
      'POST /statuses/' + gh.pr.headRefOid + ' pending',
      'PATCH /actions/variables/MERGE_GATE_AWAIT_77',
      'POST /actions/variables',
    ]);
  });

  it('opens without the review when Copilot never queues the request — and leaves a note', async () => {
    const gh = new FakeGitHub(unreviewed());
    gh.queueAfterRequest = false;
    const line = await gate(gh);
    assert.deepEqual(gh.calls, [
      'requestReviews',
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
    assert.ok(!gh.calls.includes('requestReviews'));
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
      assert.ok(!gh.calls.includes('requestReviews'), JSON.stringify(spent));
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
    assert.ok(gh.calls.includes('requestReviews'));
    assert.ok(!gh.calls.includes('addComment'));
    assert.match(line, /quota -422 \(overage 3579\)/);
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
