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
      overageRemaining: null,
      resetAt: '2026-11-01T00:00:00.000Z',
    });
  });

  // The `premium_interactions` snapshot as the endpoint gave it on 2026-10-03 at 17:10:58Z, fields
  // and all (the enclosing reset date is `reading()`'s, from the 2026-10-02 shape above). Two gate
  // log lines bracket it at the same `remaining: -422` — 17:04:02Z, the run that wrote "crédits
  // épuisés" on loudwear #18 on that alone, and 17:18:03Z. Copilot had reviewed an EARLIER head of
  // that same pull request (`dfb9c04`) at 16:59:16Z, before the force-push to the head the note
  // landed on. What this payload settles is therefore not the timing — nothing read the quota at
  // 16:59 — but the arithmetic: 421 of 4000 against a permitted overage is room, and a reading that
  // answers "exhausted" here is wrong on the numbers it was given.
  it('keeps asking past the included entitlement while the overage allowance has room', () => {
    assert.deepEqual(
      parseQuota(
        reading({
          credits_used: 7421,
          entitlement: 7000,
          has_quota: true,
          overage_count: 421,
          overage_entitlement: 4000,
          overage_permitted: true,
          percent_remaining: 0,
          quota_id: 'premium_interactions',
          quota_remaining: -421.2,
          quota_reset_at: 0,
          remaining: -422,
          timestamp_utc: '2026-10-03T17:10:58.067Z',
          token_based_billing: true,
          unlimited: false,
        }),
      ),
      { exhausted: false, remaining: -422, overageRemaining: 3579, resetAt: '2026-11-01T00:00:00.000Z' },
    );
  });

  it('is exhausted once the overage allowance is spent too', () => {
    // The last request in is the one with room left, not the one with room to spare. Every bound here
    // is synthetic — no answer with a spent allowance was ever recorded. The silence of 2026-09-30
    // (`remaining: -4171`, overage permitted) is consistent with the overshoot case below IF the cap
    // was 4000 then, which nobody measured; it is not evidence for these exact bounds. The overshoot
    // is the case a strict `> 0` catches and an `!== 0` does not: with token-based billing a single
    // review can cost more than the room left, so a count PAST the cap is plausible and must read as
    // spent, not as room again.
    assert.equal(
      parseQuota(reading({ has_quota: true, remaining: -4000, overage_permitted: true, overage_count: 4000, overage_entitlement: 4000 }))?.exhausted,
      true,
    );
    assert.equal(
      parseQuota(reading({ has_quota: true, remaining: -3999, overage_permitted: true, overage_count: 3999, overage_entitlement: 4000 }))?.exhausted,
      false,
    );
    const overshot = parseQuota(reading({ has_quota: true, remaining: -4100, overage_permitted: true, overage_count: 4100, overage_entitlement: 4000 }));
    assert.equal(overshot?.exhausted, true);
    assert.equal(overshot?.overageRemaining, -100);
  });

  it('is exhausted at zero when no overage is permitted', () => {
    assert.equal(parseQuota(reading({ has_quota: true, remaining: 0 }))?.exhausted, true);
    assert.equal(parseQuota(reading({ has_quota: true, remaining: 0, overage_permitted: false }))?.exhausted, true);
    assert.equal(parseQuota(reading({ has_quota: false, remaining: 12 }))?.exhausted, true);
  });

  it('asks anyway when the allowance is permitted but not sized', () => {
    // Synthetic, like the bounds above: the only answer recorded in full, the one at 17:10:58Z, does
    // carry both sizes, and the 2026-10-02 fixture is a hand-trimmed copy whose missing sizes may be
    // the trimming rather than the endpoint. Room the answer does not size reads as unknown, and an
    // unknown quota never stops a request — if Copilot has nothing left the request is dropped, and
    // the gate opens the pull request on that instead.
    // One size alone is no size: subtracting an absent field would give NaN, and NaN > 0 is false.
    // Unknown is reported as unknown, not reconstructed: a missing size read as zero, or sizes read
    // out of strings, would put a number in the log line that nothing measured.
    for (const sizes of [{}, { overage_entitlement: 4000 }, { overage_count: 5 }, { overage_entitlement: '4000', overage_count: '5' }]) {
      const q = parseQuota(reading({ has_quota: true, remaining: -5, overage_permitted: true, ...sizes }));
      assert.equal(q?.exhausted, false, JSON.stringify(sizes));
      assert.equal(q?.overageRemaining, null, JSON.stringify(sizes));
    }
    // `has_quota: false` with an overage permitted was never observed — at −422 it stayed `true`.
    // The reading follows the same rule rather than carving out a case nobody has seen.
    assert.equal(parseQuota(reading({ has_quota: false, remaining: -5, overage_permitted: true }))?.exhausted, false);
  });

  it('reads permission as a yes/no, and reports no allowance when none is permitted', () => {
    // Permission is the one field that says GitHub will bill further. Anything that is not the
    // boolean `true` is not a yes — otherwise an unexpected shape would have the gate wait 20 s on
    // every head. `overageRemaining` then stays null, so the log line cannot show room the gate
    // would not use.
    assert.equal(parseQuota(reading({ has_quota: true, remaining: -5, overage_permitted: 'true' }))?.exhausted, true);
    const notPermitted = parseQuota(reading({ has_quota: true, remaining: -5, overage_permitted: false, overage_entitlement: 4000, overage_count: 5 }));
    assert.equal(notPermitted?.exhausted, true);
    assert.equal(notPermitted?.overageRemaining, null);
    // A cap of zero reads as no room: nothing says the endpoint uses it for an uncapped overage.
    assert.equal(parseQuota(reading({ has_quota: true, remaining: -5, overage_permitted: true, overage_entitlement: 0, overage_count: 0 }))?.exhausted, true);
  });

  it('is never exhausted on an unlimited plan', () => {
    assert.equal(parseQuota(reading({ has_quota: true, remaining: 0, unlimited: true }))?.exhausted, false);
    assert.equal(
      parseQuota(reading({ has_quota: true, remaining: -9, unlimited: true, overage_permitted: true, overage_count: 9000, overage_entitlement: 4000 }))?.exhausted,
      false,
    );
  });

  it('is unknown when the answer has another shape', () => {
    assert.equal(parseQuota({}), null);
    assert.equal(parseQuota(reading({ entitlement: 7000 })), null);
  });
});
