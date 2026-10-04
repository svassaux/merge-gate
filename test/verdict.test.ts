import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Config, Quota, Snapshot } from '../src/model.ts';
import { ciVerdict, decide, reviewState } from '../src/verdict.ts';
import { ago, cfg, check, GREEN, HEAD, held, NOW, OLD, reviewed, snap } from './helpers.ts';

const QUOTA_OK: Quota = { exhausted: false, remaining: 1600, overageRemaining: null, resetAt: '2026-11-01T00:00:00.000Z' };
const QUOTA_OUT: Quota = { exhausted: true, remaining: 0, overageRemaining: 0, resetAt: '2026-11-01T00:00:00.000Z' };

function run(s: Snapshot, quota: Quota | null = QUOTA_OK, c: Config = cfg) {
  return decide(s, ciVerdict(s.checks, c), reviewState(s, c, NOW), quota);
}

describe('CI verdict', () => {
  it('is green when the required check passed', () => {
    assert.equal(ciVerdict(GREEN, cfg).state, 'green');
  });

  it('waits for a required check that has not appeared yet — a push the CI has not picked up', () => {
    const ci = ciVerdict([check('api', 'success')], cfg);
    assert.equal(ci.state, 'pending');
    assert.deepEqual(ci.pending, ['verify']);
  });

  it('waits when no check exists at all and none is required', () => {
    const ci = ciVerdict([], { ...cfg, requiredChecks: [] });
    assert.equal(ci.state, 'pending');
  });

  it('is red when any counted check failed, and names it', () => {
    const ci = ciVerdict([...GREEN, check('e2e', 'failure')], cfg);
    assert.equal(ci.state, 'red');
    assert.deepEqual(ci.failing, ['e2e']);
  });

  it('is red rather than pending when one check failed and another still runs', () => {
    assert.equal(ciVerdict([check('verify', 'pending'), check('api', 'failure')], cfg).state, 'red');
  });

  for (const [label, excluded, c] of [
    ['its own workflow', check('gate', 'pending', { workflow: 'merge-gate' }), cfg],
    ["Copilot's review workflow", check('review', 'pending', { workflow: 'Copilot' }), cfg],
    ["Copilot's review check, whatever reports it", check('copilot-pull-request-reviewer', 'pending', { workflow: '' }), cfg],
    ['its own status', check('merge-gate', 'pending', { workflow: '' }), cfg],
    ["the old garmlink gate's per-PR status", check('merge-gate-pr-76', 'failure', { workflow: '' }), cfg],
    ['a check the caller ignores', check('lighthouse', 'failure'), { ...cfg, ignoreChecks: ['lighthouse'] }],
  ] as const) {
    it(`leaves out ${label}`, () => {
      assert.equal(ciVerdict([...GREEN, excluded], c).state, 'green');
    });
  }

  it('lets the latest run of a check speak — a re-run that passed clears the failure', () => {
    const checks = [check('verify', 'failure', { at: ago(9) }), check('verify', 'success', { at: ago(2) })];
    assert.equal(ciVerdict(checks, cfg).state, 'green');
  });

  it('and a later failure overrides an earlier pass', () => {
    const checks = [check('verify', 'success', { at: ago(9) }), check('verify', 'failure', { at: ago(2) })];
    assert.equal(ciVerdict(checks, cfg).state, 'red');
  });

  it('counts a queued re-run, not yet started, as the newest run', () => {
    const checks = [check('verify', 'failure', { at: ago(9) }), check('verify', 'pending', { at: '￿' })];
    assert.equal(ciVerdict(checks, cfg).state, 'pending');
  });

  it('keeps two workflows with a job of the same name apart', () => {
    const checks = [check('verify', 'success', { at: ago(2) }), check('verify', 'failure', { workflow: 'Lint', at: ago(9) })];
    assert.equal(ciVerdict(checks, cfg).state, 'red');
  });

  it('counts a superseded deployment neither as a failure nor as the required check', () => {
    assert.equal(ciVerdict([...GREEN, check('garmlink - api', 'ignored', { workflow: '' })], cfg).state, 'green');
    assert.equal(ciVerdict([check('verify', 'ignored')], cfg).state, 'pending');
  });
});

describe('Copilot review', () => {
  it('is due on a pull request Copilot never reviewed', () => {
    assert.equal(reviewState(snap(), cfg, NOW).kind, 'due');
  });

  it('is not due after a clean review, even once the head moved — a CI fix costs no review', () => {
    assert.equal(reviewState(snap({ copilotReviews: [reviewed(OLD, 0)] }), cfg, NOW).kind, 'done');
  });

  it('is due when the last review opened threads and the head moved since', () => {
    assert.equal(reviewState(snap({ copilotReviews: [reviewed(OLD, 2)] }), cfg, NOW).kind, 'due');
  });

  it('is not due when the last review opened threads on this very head — they were answered without a push', () => {
    assert.equal(reviewState(snap({ copilotReviews: [reviewed(HEAD, 2)] }), cfg, NOW).kind, 'done');
  });

  it('reads the latest review, not the first', () => {
    const s = snap({ copilotReviews: [reviewed(OLD, 3, 30), reviewed(HEAD, 0, 2)] });
    assert.equal(reviewState(s, cfg, NOW).kind, 'done');
  });

  it('waits while Copilot is queued', () => {
    assert.equal(reviewState(snap({ copilotQueued: true, copilotRequestedAt: ago(19) }), cfg, NOW).kind, 'waiting');
  });

  it('gives up on a due review queued for 20 minutes', () => {
    assert.deepEqual(reviewState(snap({ copilotQueued: true, copilotRequestedAt: ago(20) }), cfg, NOW), {
      kind: 'unreviewed',
      reason: 'timeout',
    });
  });

  it('times a queue with no request event from the hand-over', () => {
    assert.equal(reviewState(held({ copilotQueued: true, labeledAt: ago(25) }), cfg, NOW).kind, 'unreviewed');
  });

  it('stops waiting on a review that was not due once the 20 minutes are up', () => {
    const s = snap({ copilotQueued: true, copilotRequestedAt: ago(21), copilotReviews: [reviewed(OLD, 0)] });
    assert.equal(reviewState(s, cfg, NOW).kind, 'done');
  });

  it('takes the recorded verdict for this head instead of asking again', () => {
    const s = snap({ note: { id: 'IC_1', head: HEAD, reason: 'ignored' } });
    assert.deepEqual(reviewState(s, cfg, NOW), { kind: 'unreviewed', reason: 'ignored' });
  });

  it('asks again on a new head after a recorded verdict', () => {
    assert.equal(reviewState(snap({ note: { id: 'IC_1', head: OLD, reason: 'quota' } }), cfg, NOW).kind, 'due');
  });

  describe('with first-review: ruleset', () => {
    const ruleset: Config = { ...cfg, firstReview: 'ruleset' };
    it('leaves the first review to the ruleset during the hand-over', () => {
      assert.equal(reviewState(snap(), ruleset, NOW).kind, 'grace');
      assert.equal(reviewState(held({ labeledAt: ago(4) }), ruleset, NOW).kind, 'grace');
    });
    it('asks itself once the ruleset let 5 minutes pass', () => {
      assert.equal(reviewState(held({ labeledAt: ago(5) }), ruleset, NOW).kind, 'due');
    });
    it('asks for a re-review at once — the ruleset only ever gives the first', () => {
      assert.equal(reviewState(held({ labeledAt: ago(1), copilotReviews: [reviewed(OLD, 1)] }), ruleset, NOW).kind, 'due');
    });
  });
});

describe('decision', () => {
  it('does nothing with a closed pull request but drop its wake-up', () => {
    const plan = run(held({ open: false, copilotQueued: true, copilotRequestedAt: ago(1) }));
    assert.equal(plan.kind, 'closed');
    assert.equal(plan.status, null);
    assert.equal(plan.request, false);
    assert.equal(plan.awaiting, false);
  });

  it('leaves a work draft alone, saying how to hand it over', () => {
    const plan = run(snap({ draft: true, checks: [check('verify', 'failure')] }));
    assert.equal(plan.kind, 'work-draft');
    assert.deepEqual([plan.label, plan.draft, plan.request, plan.awaiting], [null, null, false, false]);
    assert.equal(plan.status?.state, 'pending');
    assert.match(plan.status?.description ?? '', /^Brouillon de travail/);
  });

  it('takes a pull request marked ready: labels it, draws it back to draft and asks Copilot while the CI runs', () => {
    const plan = run(snap({ checks: [check('verify', 'pending')] }));
    assert.equal(plan.kind, 'hold');
    assert.deepEqual([plan.label, plan.draft, plan.request, plan.awaiting], ['add', 'to-draft', true, true]);
    assert.equal(plan.status?.state, 'pending');
    assert.match(plan.status?.description ?? '', /revue Copilot demandée · CI en cours : verify/);
  });

  it('opens a held pull request once the CI is green, the review in and no thread open', () => {
    const plan = run(held({ copilotReviews: [reviewed(HEAD, 0)] }));
    assert.equal(plan.kind, 'open');
    assert.deepEqual([plan.draft, plan.label, plan.request, plan.awaiting], ['to-ready', 'remove', false, false]);
    assert.deepEqual(plan.status, { state: 'success', description: 'Prête — CI verte, relue par Copilot, aucun fil ouvert' });
  });

  it('leaves an open pull request open when nothing changed', () => {
    const plan = run(snap({ copilotReviews: [reviewed(HEAD, 0)] }));
    assert.equal(plan.kind, 'open');
    assert.deepEqual([plan.draft, plan.label], [null, null]);
  });

  it('draws an open pull request back when a thread is opened on it', () => {
    const plan = run(snap({ copilotReviews: [reviewed(HEAD, 0)], unresolvedThreads: 1 }));
    assert.deepEqual([plan.kind, plan.label, plan.draft], ['hold', 'add', 'to-draft']);
  });

  it('never asks while a thread is open, and says the author must act', () => {
    const plan = run(held({ copilotReviews: [reviewed(OLD, 2)], unresolvedThreads: 2 }));
    assert.equal(plan.request, false);
    assert.equal(plan.awaiting, false);
    assert.equal(plan.status?.state, 'failure');
    assert.match(plan.status?.description ?? '', /2 fils ouverts à traiter/);
  });

  it('never asks while the CI is red', () => {
    const plan = run(held({ checks: [check('verify', 'failure')] }));
    assert.equal(plan.request, false);
    assert.equal(plan.status?.state, 'failure');
    assert.match(plan.status?.description ?? '', /CI rouge : verify/);
  });

  it('never asks while Copilot is already queued — a second request would strand in the queue', () => {
    const plan = run(held({ copilotQueued: true, copilotRequestedAt: ago(3) }));
    assert.equal(plan.request, false);
    assert.equal(plan.awaiting, true);
    assert.match(plan.status?.description ?? '', /Copilot relit/);
  });

  it('keeps the sweep while a deployment status is pending — no workflow event announces its end', () => {
    const plan = run(held({ copilotReviews: [reviewed(HEAD, 0)], checks: [...GREEN, check('garmlink - web', 'pending', { workflow: '' })] }));
    assert.deepEqual([plan.kind, plan.request, plan.awaiting], ['hold', false, true]);
    assert.match(plan.status?.description ?? '', /CI en cours : garmlink - web/);
  });

  it('drops the sweep while the author must act on a red CI', () => {
    const plan = run(held({ copilotReviews: [reviewed(HEAD, 0)], checks: [check('verify', 'failure'), check('e2e', 'pending')] }));
    assert.equal(plan.awaiting, false);
  });

  it('asks for the re-review once the threads are resolved after a push', () => {
    const plan = run(held({ copilotReviews: [reviewed(OLD, 2)] }));
    assert.equal(plan.request, true);
    assert.equal(plan.kind, 'hold');
  });

  it('asks when the quota cannot be read', () => {
    assert.equal(run(held(), null).request, true);
  });

  it('opens without a review when the credits are exhausted — and says so', () => {
    const plan = run(held(), QUOTA_OUT);
    assert.equal(plan.request, false);
    assert.equal(plan.kind, 'open');
    assert.equal(plan.note, 'quota');
    assert.equal(plan.status?.state, 'success');
    assert.match(plan.status?.description ?? '', /NON relue par Copilot : crédits Copilot épuisés/);
  });

  it('records the exhausted credits at once, while it still waits for the CI', () => {
    const plan = run(held({ checks: [check('verify', 'pending')] }), QUOTA_OUT);
    assert.deepEqual([plan.kind, plan.note, plan.request, plan.awaiting], ['hold', 'quota', false, false]);
    assert.match(plan.status?.description ?? '', /sans revue Copilot \(crédits Copilot épuisés\)/);
  });

  it('opens after a review queued for 20 minutes, and records it', () => {
    const plan = run(held({ copilotQueued: true, copilotRequestedAt: ago(25) }));
    assert.deepEqual([plan.kind, plan.note], ['open', 'timeout']);
  });

  it('opens on an ignored request', () => {
    const s = held();
    const plan = decide(s, ciVerdict(s.checks, cfg), { kind: 'unreviewed', reason: 'ignored' }, QUOTA_OK);
    assert.deepEqual([plan.kind, plan.note, plan.request], ['open', 'ignored', false]);
  });

  it('does not record the same verdict twice on one head', () => {
    const plan = run(held({ note: { id: 'IC_1', head: HEAD, reason: 'quota' } }), QUOTA_OUT);
    assert.equal(plan.kind, 'open');
    assert.equal(plan.note, null);
  });

  it('keeps the wake-up while the ruleset has the first review', () => {
    const plan = run(held({ labeledAt: ago(1) }), QUOTA_OK, { ...cfg, firstReview: 'ruleset' });
    assert.deepEqual([plan.kind, plan.request, plan.awaiting], ['hold', false, true]);
  });

  it('keeps every status description within the 140 characters GitHub accepts', () => {
    const many = Array.from({ length: 30 }, (_, i) => check(`job-${i}`, 'failure'));
    const plan = run(held({ checks: many, unresolvedThreads: 3 }));
    assert.ok((plan.status?.description.length ?? 0) <= 140);
    assert.ok((plan.status?.description.length ?? 0) > 100);
  });
});
