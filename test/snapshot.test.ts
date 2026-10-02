import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parseQuota, parseSnapshot, type RawPullRequest } from '../src/snapshot.ts';
import { ciVerdict, reviewState } from '../src/verdict.ts';
import { cfg } from './helpers.ts';

/** Real answers to the gate's query, recorded with scripts/record-fixture.ts. */
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as RawPullRequest;

describe('reading a real pull request', () => {
  // garmlink #76, merged 2026-10-02: thirteen Copilot reviews, twenty threads, all resolved.
  const s = parseSnapshot(fixture('garmlink-76'));

  it('finds every Copilot review, oldest first, with the threads each opened', () => {
    assert.equal(s.copilotReviews.length, 13);
    assert.deepEqual(s.copilotReviews.at(0), {
      commit: s.copilotReviews[0]?.commit,
      submittedAt: s.copilotReviews[0]?.submittedAt,
      comments: 4,
    });
    assert.equal(s.copilotReviews.at(-1)?.commit, s.head);
    assert.equal(s.copilotReviews.at(-1)?.comments, 0);
    const times = s.copilotReviews.map((r) => r.submittedAt);
    assert.deepEqual(times, [...times].sort());
  });

  it('knows the last request to Copilot and that nothing is queued', () => {
    assert.equal(s.copilotRequestedAt, '2026-10-01T20:53:39Z');
    assert.equal(s.copilotQueued, false);
  });

  it('counts the threads and finds none open', () => {
    assert.equal(s.unresolvedThreads, 0);
  });

  it("reads the checks of the head with their workflow, and the deployments' statuses", () => {
    const verify = s.checks.filter((c) => c.name === 'verify');
    assert.deepEqual(
      verify.map((c) => [c.workflow, c.state]),
      [['CI', 'success']],
    );
    assert.equal(s.checks.filter((c) => c.workflow === 'merge-gate').length, 3);
    assert.ok(s.checks.some((c) => c.workflow === '' && c.name === 'garmlink - api' && c.state === 'success'));
    assert.equal(s.checks.find((c) => c.name === 'web')?.state, 'success', 'a skipped job counts as passed');
  });

  it("finds the CI green once the old gate's cancelled run and per-PR status are left out", () => {
    assert.ok(s.checks.some((c) => c.workflow === 'merge-gate' && c.state === 'failure'));
    assert.equal(ciVerdict(s.checks, cfg).state, 'green');
  });

  it('sees the pull request as merged, not open', () => {
    assert.equal(s.open, false);
    assert.equal(s.labeled, false);
    assert.equal(s.gateStatus, null);
  });

  // garmlink #77, open: one review on its head that opened a thread, answered and resolved since.
  const open = parseSnapshot(fixture('garmlink-77'));

  it('owes no review to an open pull request whose threads on this head were answered', () => {
    assert.equal(open.open, true);
    assert.equal(open.copilotReviews.length, 1);
    assert.equal(open.copilotReviews[0]?.comments, 1);
    assert.equal(reviewState(open, cfg, new Date('2026-10-02T12:00:00Z')).kind, 'done');
    assert.equal(ciVerdict(open.checks, cfg).state, 'green');
  });
});

describe('the gate’s own marks', () => {
  const base = fixture('garmlink-77');
  const head = base.headRefOid;

  it('reads its status on the head', () => {
    const raw = structuredClone(base);
    raw.commits.nodes[0]!.commit.statusCheckRollup!.contexts.nodes.push({
      __typename: 'StatusContext',
      context: 'merge-gate',
      state: 'PENDING',
      description: 'Copilot relit',
      createdAt: '2026-10-02T10:00:00Z',
    });
    assert.deepEqual(parseSnapshot(raw).gateStatus, { state: 'pending', description: 'Copilot relit' });
  });

  it('reads its note, and only a note it wrote', () => {
    const raw = structuredClone(base);
    raw.comments.nodes.push(
      { id: 'IC_b', body: `<!-- merge-gate:unreviewed head=${head} reason=timeout -->\n**Pas de revue**` },
      { id: 'IC_a', body: `Quoting <!-- merge-gate:unreviewed head=${head} reason=quota --> is not a note` },
    );
    assert.deepEqual(parseSnapshot(raw).note, { id: 'IC_b', head, reason: 'timeout' });
  });

  it('knows when its label was put on', () => {
    const raw = structuredClone(base);
    raw.labels.nodes.push({ name: 'merge-gate' });
    raw.timelineItems.nodes.push(
      { __typename: 'LabeledEvent', createdAt: '2026-10-02T10:00:00Z', label: { name: 'merge-gate' } },
      { __typename: 'LabeledEvent', createdAt: '2026-10-02T11:00:00Z', label: { name: 'bug' } },
    );
    const s = parseSnapshot(raw);
    assert.equal(s.labeled, true);
    assert.equal(s.labeledAt, '2026-10-02T10:00:00Z');
  });

  it('sees Copilot in the queue, and only Copilot', () => {
    const raw = structuredClone(base);
    raw.reviewRequests.nodes.push({ requestedReviewer: { __typename: 'User', login: 'someone' } });
    assert.equal(parseSnapshot(raw).copilotQueued, false);
    raw.reviewRequests.nodes.push(
      { requestedReviewer: { __typename: 'Bot', login: 'copilot-pull-request-reviewer' } },
    );
    assert.equal(parseSnapshot(raw).copilotQueued, true);
  });

  it('reads a check still running, and a queued one as the newest', () => {
    const raw = structuredClone(base);
    const nodes = raw.commits.nodes[0]!.commit.statusCheckRollup!.contexts.nodes;
    nodes.push({
      __typename: 'CheckRun',
      name: 'verify',
      status: 'QUEUED',
      conclusion: null,
      startedAt: null,
      completedAt: null,
      checkSuite: { workflowRun: { workflow: { name: 'CI' } } },
    });
    const s = parseSnapshot(raw);
    assert.equal(ciVerdict(s.checks, cfg).state, 'pending');
  });

  it('ignores a deployment cancelled because a second one replaced it, and fails one that errored', () => {
    const raw = structuredClone(base);
    const nodes = raw.commits.nodes[0]!.commit.statusCheckRollup!.contexts.nodes;
    nodes.push({ __typename: 'StatusContext', context: 'garmlink - web', state: 'FAILURE', description: 'Deployment cancelled', createdAt: '2026-10-02T11:00:00Z' });
    assert.equal(ciVerdict(parseSnapshot(raw).checks, cfg).state, 'green');
    nodes.push({ __typename: 'StatusContext', context: 'garmlink - api', state: 'ERROR', description: 'Build failed', createdAt: '2026-10-02T11:01:00Z' });
    assert.equal(ciVerdict(parseSnapshot(raw).checks, cfg).state, 'red');
  });
});

describe('the Copilot quota', () => {
  // The shape copilot_internal/user returned to GATE_TOKEN from an Actions run on 2026-10-02.
  const reading = (q: object) => ({ quota_reset_date_utc: '2026-11-01T00:00:00.000Z', quota_snapshots: { premium_interactions: q } });

  it('has credits left', () => {
    assert.deepEqual(parseQuota(reading({ has_quota: true, remaining: 1656, percent_remaining: 23.6, overage_permitted: true })), {
      exhausted: false,
      remaining: 1656,
      resetAt: '2026-11-01T00:00:00.000Z',
    });
  });

  it('is exhausted at zero, even when overage is permitted — the reviews of 2026-09-30 never came', () => {
    assert.equal(parseQuota(reading({ has_quota: true, remaining: 0, overage_permitted: true }))?.exhausted, true);
    assert.equal(parseQuota(reading({ has_quota: false, remaining: 12 }))?.exhausted, true);
  });

  it('is never exhausted on an unlimited plan', () => {
    assert.equal(parseQuota(reading({ has_quota: true, remaining: 0, unlimited: true }))?.exhausted, false);
  });

  it('is unknown when the answer has another shape', () => {
    assert.equal(parseQuota({}), null);
    assert.equal(parseQuota(reading({ entitlement: 7000 })), null);
  });
});
