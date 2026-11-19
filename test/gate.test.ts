import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { gatePullRequest, noteBody } from '../src/gate.ts';
import { HttpError, isThrottled, type Api, type Response } from '../src/github.ts';
import { LOVABLE_MARK, REVIEW_EFFORTS, type Unreviewed } from '../src/model.ts';
import { VERDICTS_SCHEMA } from '../src/prompts.ts';
import { RelayError, type JsonAnswer, type JsonRequest, type Relay } from '../src/relay.ts';
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
  /** The status descriptions the gate wrote, in order. */
  readonly statuses: string[] = [];
  /** What the pull request changes, as `GET /pulls/{n}/files` lists it: read by the Lovable review only. */
  files = [{ filename: 'src/a.ts', status: 'added', patch: '@@ -0,0 +1,3 @@\n+const a = 1;\n+const b = a / 0;\n+export { b };' }];
  /** The Lovable review the gate posted. */
  review: { body: string; comments: unknown[] } | null = null;
  /** The status GitHub answers the review's post with. */
  reviewAnswer = 200;
  /** Reads keep showing the pull request as it was before the review was posted. */
  lagging = false;
  /** A push lands right after the review is posted. */
  moveAfterPost = false;
  /** A GitHub outage on the reads whose `METHOD /path` starts with this: a 502, or no answer at all (0). */
  outageOn: string | null = null;
  outageStatus = 502;
  before: RawPullRequest | null = null;
  readonly pr: RawPullRequest;

  constructor(pr: RawPullRequest) {
    this.pr = pr;
  }

  repoPath(path: string): string {
    return `/repos/${this.owner}/${this.repo}${path}`;
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    if (query === SNAPSHOT_QUERY) {
      // A read that lags behind the review the gate posted still shows the pull request without it.
      const pr = this.lagging ? this.before ?? this.pr : this.pr;
      return { viewer: { login: 'svassaux' }, repository: { pullRequest: pr } } as T;
    }
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
    // The writes a later read sees: a run that reads the pull request again after a Lovable review.
    if (name === 'convertPullRequestToDraft') this.pr.isDraft = true;
    if (name === 'markPullRequestReadyForReview') this.pr.isDraft = false;
    return {} as T;
  }

  async rest<T>(method: string, path: string, body?: unknown): Promise<Response<T>> {
    const short = `${method} ${path.replace(this.repoPath(''), '')}`;
    if (short === 'GET /copilot_internal/user') return { status: this.quota ? 200 : 404, data: this.quota as T };
    if (short.startsWith(this.failOn ?? '\0')) throw new Error(`${short} refused`);
    if (short.startsWith(this.outageOn ?? '\0')) throw new HttpError(this.outageStatus, `${short}: ${this.outageStatus}`);
    if (short === 'GET /pulls/77') return { status: 200, data: { title: 'A change', body: '', head: { sha: this.pr.headRefOid } } as T };
    if (short.startsWith('GET /pulls/77/files')) return { status: 200, data: (short.includes('page=1') ? this.files : []) as T };
    if (short.startsWith('GET /contents/')) return { status: 404, data: null as T };
    if (short === 'POST /pulls/77/reviews') {
      this.calls.push(short);
      if (this.reviewAnswer !== 200) return { status: this.reviewAnswer, data: null as T };
      this.review = body as { body: string; comments: unknown[] };
      this.before = structuredClone(this.pr);
      this.pr.gateReviews = {
        nodes: [
          ...(this.pr.gateReviews?.nodes ?? []),
          { author: { login: 'svassaux' }, body: this.review.body, submittedAt: NOW.toISOString(), commit: { oid: this.pr.headRefOid } },
        ],
      };
      for (const _ of this.review.comments) this.pr.reviewThreads.nodes.push({ isResolved: false });
      if (this.moveAfterPost) this.pr.headRefOid = 'e'.repeat(40);
      return { status: 200, data: null as T };
    }
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
    const description = (body as { description?: string } | undefined)?.description;
    if (path.includes('/statuses/') && description) {
      this.statuses.push(description);
      // The rollup holds a context's last status only.
      const contexts = this.pr.commits.nodes[0]!.commit.statusCheckRollup!.contexts;
      contexts.nodes = contexts.nodes.filter((c) => !(c?.__typename === 'StatusContext' && c.context === 'merge-gate'));
      contexts.nodes.push({
        __typename: 'StatusContext',
        context: 'merge-gate',
        state: String(state).toUpperCase(),
        description,
        createdAt: NOW.toISOString(),
      });
    }
    if (short === 'POST /issues/77/labels') this.pr.labels.nodes.push({ name: 'merge-gate' });
    if (short === 'DELETE /issues/77/labels/merge-gate') this.pr.labels.nodes = this.pr.labels.nodes.filter((l) => l?.name !== 'merge-gate');
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

/**
 * A relay that finds `findings` on src/a.ts and whose verifier keeps them all, or that fails every
 * call with `error`. Counts its calls.
 */
function fakeRelay(findings: { line: number; title: string }[], error: RelayError | null = null): Relay & { calls: number } {
  return {
    calls: 0,
    async json<T>(req: JsonRequest): Promise<JsonAnswer<T>> {
      this.calls++;
      if (error) throw error;
      const done = (value: unknown) => ({ value: value as T, usage: { prompt: 1, completion: 1, reasoning: 0 }, model: req.model, ms: 1 });
      if (req.schema !== VERDICTS_SCHEMA) {
        // One finder only, so that each finding is proposed once.
        const mine = req.model === 'openai/gpt-6.1-terra' ? findings : [];
        return done({ findings: mine.map((f) => ({ path: 'src/a.ts', severity: 'high', category: 'logic', explanation: 'Divides by zero.', fix: '', ...f })) });
      }
      const candidates = JSON.parse(req.user.slice(req.user.indexOf('[', req.user.indexOf('===== CANDIDATE FINDINGS')))) as { id: number }[];
      return done({ verdicts: candidates.map((c) => ({ ...c, keep: true, reason: 'traced' })) });
    },
  };
}

/** The quota GitHub answered on 2026-11-19: the included entitlement spent, the paid overage running. */
const OVERAGE = {
  quota_snapshots: {
    premium_interactions: { has_quota: true, remaining: -2092, overage_permitted: true, overage_count: 2091, overage_entitlement: 8000, unlimited: false },
  },
};
const EXHAUSTED = { quota_snapshots: { premium_interactions: { has_quota: false, remaining: 0 } } };
const withRelay = (gh: FakeGitHub, relay: Relay) =>
  gatePullRequest(gh, 77, { ...cfg, lovable: true }, RUN, { now: NOW, registerWaitS: 0, relay, review: { clock: () => 0 } });

describe('the Lovable relay in Copilot’s place', () => {
  it('past Copilot’s included credits: holds the pull request, has the relay review it, and opens it on a clean review', async () => {
    const gh = new FakeGitHub(unreviewed());
    gh.quota = OVERAGE;
    const relay = fakeRelay([]);
    const line = await withRelay(gh, relay);
    assert.ok(!gh.calls.includes(ASK), 'the paid overage is left alone');
    assert.ok(relay.calls > 0);
    const head = gh.pr.headRefOid;
    assert.deepEqual(gh.calls, [
      'POST /issues/77/labels',
      'convertPullRequestToDraft',
      `POST /statuses/${head} pending`,
      'PATCH /actions/variables/MERGE_GATE_AWAIT_77',
      'POST /actions/variables',
      'POST /pulls/77/reviews',
      'markPullRequestReadyForReview',
      'DELETE /issues/77/labels/merge-gate',
      `POST /statuses/${head} success`,
      'DELETE /actions/variables/MERGE_GATE_AWAIT_77',
    ]);
    assert.match(gh.statuses[0] ?? '', /Lovable relit \(crédits Copilot inclus épuisés/);
    assert.equal(gh.statuses[1], 'Prête — CI verte, relue par Lovable à la place de Copilot, aucun fil ouvert');
    assert.ok(gh.review?.body.startsWith(`${LOVABLE_MARK} head=${head} -->`));
    assert.match(line, /relue par Lovable : 0 fil\(s\)/);
  });

  it('without the relay’s secrets, still asks Copilot past its included credits', async () => {
    const gh = new FakeGitHub(unreviewed());
    gh.quota = OVERAGE;
    await gatePullRequest(gh, 77, { ...cfg, lovable: true }, RUN, { now: NOW, registerWaitS: 0 });
    assert.ok(gh.calls.includes(ASK));
  });

  it('keeps the pull request in draft when the review opened a thread: it is the author’s to answer', async () => {
    const gh = new FakeGitHub(unreviewed());
    gh.quota = EXHAUSTED;
    await withRelay(gh, fakeRelay([{ line: 2, title: 'b divides by zero' }]));
    assert.equal(gh.review?.comments.length, 1);
    assert.ok(!gh.calls.includes('markPullRequestReadyForReview'));
    assert.match(gh.statuses.at(-1) ?? '', /^Gardée en brouillon — 1 fil ouvert à traiter/);
    assert.equal(gh.calls.at(-1), 'DELETE /actions/variables/MERGE_GATE_AWAIT_77', 'nothing left to wake up for');
  });

  it('opens with a note naming both failures when the relay has no credit left', async () => {
    const gh = new FakeGitHub(unreviewed());
    gh.quota = OVERAGE;
    const line = await withRelay(gh, fakeRelay([], new RelayError('credits', 402, 'relais 402')));
    assert.equal(gh.review, null);
    assert.match(gh.note, /reason=overage lovable=credits -->/);
    assert.match(gh.note, /Ni de relecture Lovable\*\* : crédits Lovable épuisés/);
    assert.equal(gh.statuses.at(-1), 'Prête — NON relue par Copilot : crédits Copilot inclus épuisés, dépassement payant évité · ni par Lovable : crédits Lovable épuisés');
    assert.match(line, /relecture Lovable impossible \(credits\)/);
  });

  it('starts no second review while another run’s is in flight, and starts one once that run is dead', async () => {
    // The sweep shares no concurrency group with the pull request's runs: it reads the status the
    // reviewing run wrote before starting, and when — Copilot still queued past its timeout included.
    for (const [reason, minAgo, expected] of [
      ['overage', 5, 0],
      ['overage', 25, 1],
      ['timeout', 5, 0],
      ['timeout', 25, 1],
    ] as const) {
      const pr = unreviewed();
      pr.isDraft = true;
      pr.labels.nodes.push({ name: 'merge-gate' });
      if (reason === 'timeout') {
        const copilot = { __typename: 'Bot', login: 'copilot-pull-request-reviewer' };
        pr.reviewRequests.nodes = [{ requestedReviewer: copilot }];
        pr.timelineItems.nodes.push({ __typename: 'ReviewRequestedEvent', createdAt: new Date(NOW.getTime() - 60 * 60_000).toISOString(), requestedReviewer: copilot });
      }
      const relaying = `Gardée en brouillon — Lovable relit (${REASONS[reason]})`;
      pr.commits.nodes[0]!.commit.statusCheckRollup!.contexts.nodes.push({
        __typename: 'StatusContext',
        context: 'merge-gate',
        state: 'PENDING',
        description: relaying,
        createdAt: new Date(NOW.getTime() - minAgo * 60_000).toISOString(),
      });
      const gh = new FakeGitHub(pr);
      gh.quota = OVERAGE;
      await withRelay(gh, fakeRelay([]));
      const label = `${reason}, ${minAgo} min`;
      assert.equal(gh.calls.filter((c) => c === 'POST /pulls/77/reviews').length, expected, label);
      assert.ok(!gh.calls.includes(ASK), label);
      if (expected === 0) assert.deepEqual(gh.calls, ['PATCH /actions/variables/MERGE_GATE_AWAIT_77', 'POST /actions/variables'], `${label}: the sweep looks again later`);
      // The dead run's status reads the same: written again all the same, as its time is the lock.
      else assert.equal(gh.statuses[0], relaying, label);
    }
  });

  it('leaves the in-flight review’s status alone when the CI turned red meanwhile: it is the lock', async () => {
    const pr = unreviewed();
    pr.isDraft = true;
    pr.labels.nodes.push({ name: 'merge-gate' });
    const nodes = pr.commits.nodes[0]!.commit.statusCheckRollup!.contexts.nodes;
    for (const c of nodes) if (c?.__typename === 'CheckRun' && c.name === 'verify') c.conclusion = 'FAILURE';
    nodes.push({
      __typename: 'StatusContext',
      context: 'merge-gate',
      state: 'PENDING',
      description: `Gardée en brouillon — Lovable relit (${REASONS.overage})`,
      createdAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
    });
    const gh = new FakeGitHub(pr);
    gh.quota = OVERAGE;
    await withRelay(gh, fakeRelay([]));
    assert.deepEqual(gh.statuses, []);
    assert.ok(!gh.calls.includes('POST /pulls/77/reviews'));
  });

  it('leaves the in-flight review’s status alone even when the watching run fails: it is the lock', async () => {
    const pr = unreviewed();
    pr.isDraft = true;
    pr.labels.nodes.push({ name: 'merge-gate' });
    pr.commits.nodes[0]!.commit.statusCheckRollup!.contexts.nodes.push({
      __typename: 'StatusContext',
      context: 'merge-gate',
      state: 'PENDING',
      description: `Gardée en brouillon — Lovable relit (${REASONS.overage})`,
      createdAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
    });
    const gh = new FakeGitHub(pr);
    gh.quota = OVERAGE;
    // The wake-up's write is the one thing a watching run does.
    gh.failOn = 'PATCH /actions/variables';
    await assert.rejects(withRelay(gh, fakeRelay([])), /refused/);
    assert.deepEqual(gh.statuses, [], 'no failure written over the lock');
  });

  it('posts nothing and decides nothing when the head moves during the review, or right after it', async () => {
    const during = new FakeGitHub(unreviewed());
    during.quota = OVERAGE;
    const relay = fakeRelay([]);
    const json = relay.json.bind(relay);
    relay.json = async <T,>(req: JsonRequest) => {
      during.pr.headRefOid = 'd'.repeat(40);
      return json<T>(req);
    };
    const line = await withRelay(during, relay);
    assert.match(line, /la tête a bougé pendant la relecture, rien n’est posté/);
    assert.ok(!during.calls.includes('POST /pulls/77/reviews'));
    assert.equal(during.statuses.length, 1, 'the interim status only: the new head’s run decides');

    const after = new FakeGitHub(unreviewed());
    after.quota = OVERAGE;
    after.moveAfterPost = true;
    assert.match(await withRelay(after, fakeRelay([])), /la tête a bougé depuis : son run décidera/);
    assert.ok(after.review);
    assert.equal(after.statuses.length, 1);
  });

  it('fails the run when GitHub is out or out of reach during the review, without a note: a later run reviews again', async () => {
    for (const status of [502, 0]) {
      const gh = new FakeGitHub(unreviewed());
      gh.quota = OVERAGE;
      gh.outageOn = 'GET /pulls/77/files';
      gh.outageStatus = status;
      await assert.rejects(withRelay(gh, fakeRelay([])), (e: HttpError) => e.status === status);
      assert.equal(gh.note, '', String(status));
      assert.equal(gh.statuses.length, 1);
      assert.ok(!gh.calls.includes('DELETE /actions/variables/MERGE_GATE_AWAIT_77'), 'the wake-up stays');
    }
  });

  it('when the relay fails after Copilot reviewed meanwhile: Copilot’s review stands, and no note says there was none', async () => {
    const gh = new FakeGitHub(unreviewed());
    gh.quota = OVERAGE;
    const relay: Relay = {
      async json() {
        if (gh.pr.reviews.nodes.length === 0) gh.pr.reviews.nodes.push({ submittedAt: NOW.toISOString(), commit: { oid: gh.pr.headRefOid }, comments: { totalCount: 0 } });
        throw new RelayError('credits', 402, 'relais 402');
      },
    };
    await withRelay(gh, relay);
    assert.equal(gh.note, '');
    assert.equal(gh.statuses.at(-1), 'Prête — CI verte, relue par Copilot, aucun fil ouvert');
  });

  it('has the relay review one pull request a run: the next waits, held and awaited, for a later run', async () => {
    const relayTurn = { taken: false };
    const run = (gh: FakeGitHub, relay: Relay) =>
      gatePullRequest(gh, 77, { ...cfg, lovable: true }, RUN, { now: NOW, registerWaitS: 0, relay, review: { clock: () => 0 }, relayTurn });
    const first = new FakeGitHub(unreviewed());
    first.quota = OVERAGE;
    await run(first, fakeRelay([]));
    assert.ok(first.review);
    const second = new FakeGitHub(unreviewed());
    second.quota = OVERAGE;
    const relay = fakeRelay([]);
    await run(second, relay);
    assert.equal(relay.calls, 0);
    assert.equal(second.review, null);
    assert.match(second.statuses.at(-1) ?? '', /^Gardée en brouillon — relecture Lovable à venir \(crédits Copilot inclus épuisés/);
    assert.ok(second.calls.includes('POST /actions/variables') && !second.calls.includes('DELETE /actions/variables/MERGE_GATE_AWAIT_77'));
  });

  it('decides all the same when GitHub refuses the review: a note, no wake-up that would start it again', async () => {
    const gh = new FakeGitHub(unreviewed());
    gh.quota = OVERAGE;
    gh.reviewAnswer = 422;
    const line = await withRelay(gh, fakeRelay([]));
    assert.ok(gh.calls.includes('POST /pulls/77/reviews'));
    assert.match(gh.note, /reason=overage lovable=unavailable -->/);
    assert.match(gh.statuses.at(-1) ?? '', /^Prête — NON relue par Copilot : .* · ni par Lovable/);
    assert.equal(gh.calls.at(-1), 'DELETE /actions/variables/MERGE_GATE_AWAIT_77');
    assert.match(line, /relecture Lovable en échec : POST \/pulls\/77\/reviews: 422/);
  });

  it('counts the review it posted even when GitHub’s next read does not show it yet', async () => {
    for (const [findings, expected] of [
      [[], /^Prête — CI verte, relue par Lovable/],
      [[{ line: 2, title: 'b divides by zero' }], /^Gardée en brouillon — 1 fil ouvert à traiter/],
    ] as const) {
      const gh = new FakeGitHub(unreviewed());
      gh.quota = OVERAGE;
      gh.lagging = true;
      await withRelay(gh, fakeRelay([...findings]));
      assert.ok(gh.review);
      assert.match(gh.statuses.at(-1) ?? '', expected);
    }
  });

  it('decides on the pull request as it is after the review: a CI that turned red meanwhile keeps it held', async () => {
    const gh = new FakeGitHub(unreviewed());
    gh.quota = OVERAGE;
    const relay = fakeRelay([]);
    const json = relay.json.bind(relay);
    relay.json = async <T,>(req: JsonRequest) => {
      const nodes = gh.pr.commits.nodes[0]!.commit.statusCheckRollup!.contexts.nodes;
      for (const c of nodes) if (c?.__typename === 'CheckRun' && c.name === 'verify') c.conclusion = 'FAILURE';
      return json<T>(req);
    };
    await withRelay(gh, relay);
    assert.ok(gh.review);
    assert.ok(!gh.calls.includes('markPullRequestReadyForReview'));
    assert.match(gh.statuses.at(-1) ?? '', /^Gardée en brouillon — CI rouge : verify/);
  });

  it('reads that note back: a run after it neither calls the relay again nor asks Copilot', async () => {
    const pr = unreviewed();
    pr.comments.nodes.push({ id: 'IC_note', body: noteBody(pr.headRefOid, 'overage', null, 'credits') });
    const gh = new FakeGitHub(pr);
    gh.quota = OVERAGE;
    const relay = fakeRelay([]);
    await withRelay(gh, relay);
    assert.equal(relay.calls, 0);
    assert.ok(!gh.calls.includes(ASK) && !gh.calls.includes('addComment') && !gh.calls.includes('updateIssueComment'));
  });

  it('takes the relay’s review as the pull request’s one review, on any later head', async () => {
    const pr = unreviewed();
    pr.gateReviews = {
      nodes: [{ author: { login: 'svassaux' }, body: `${LOVABLE_MARK} head=${'b'.repeat(40)} -->\n### Relecture Lovable`, submittedAt: '2026-10-02T11:00:00Z', commit: { oid: 'b'.repeat(40) } }],
    };
    const gh = new FakeGitHub(pr);
    gh.quota = OVERAGE;
    const relay = fakeRelay([]);
    await withRelay(gh, relay);
    assert.equal(relay.calls, 0);
    assert.ok(!gh.calls.includes(ASK));
    assert.equal(gh.statuses.at(-1), 'Prête — CI verte, relue par Lovable à la place de Copilot, aucun fil ouvert');
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
