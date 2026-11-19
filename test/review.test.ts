import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { anchor, annotate } from '../src/diff.ts';
import type { Api, Response } from '../src/github.ts';
import { LOVABLE_MARK } from '../src/model.ts';
import { VERDICTS_SCHEMA } from '../src/prompts.ts';
import { RelayError, type JsonAnswer, type JsonRequest, type Relay } from '../src/relay.ts';
import { DEEP, reviewWithLovable, SECOND, WIDE, type ReviewOptions } from '../src/review.ts';

/** A real patch and its head file (merge-gate #5): the review reads it as it would read GitHub's. */
const real = (
  JSON.parse(readFileSync(new URL('./fixtures/merge-gate-5-patch.json', import.meta.url), 'utf8')) as {
    files: { path: string; patch: string; content: string }[];
  }
).files[0]!;
const ann = annotate(real.patch);
const ADDED = [...ann.added].sort((a, b) => a - b);
const CONTEXT = [...ann.commentable].filter((n) => !ann.added.has(n)).sort((a, b) => a - b);
const HEAD = 'c'.repeat(40);

interface Posted {
  body: string;
  comments: { path: string; line: number; side: string; body: string }[];
}

/** A repository holding one pull request: the real file, a lock file, and whatever the review posts. */
class FakeRepo implements Api {
  readonly owner = 'svassaux';
  readonly repo = 'demo';
  head = HEAD;
  files = [
    { filename: real.path, status: 'modified', patch: real.patch },
    { filename: 'pnpm-lock.yaml', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' },
  ];
  /** The pull request no longer answers (404). */
  gone = false;
  /** What GitHub answers the list of files with, when it refuses it. */
  filesStatus = 200;
  /** Statuses the review POST gets in turn; 200 once they run out. */
  reviewAnswers: number[] = [];
  readonly posted: Posted[] = [];

  repoPath(path: string): string {
    return `/repos/${this.owner}/${this.repo}${path}`;
  }

  async graphql<T>(): Promise<T> {
    throw new Error('the review reads nothing through GraphQL');
  }

  async rest<T>(method: string, path: string, body?: unknown): Promise<Response<T>> {
    const short = path.replace(this.repoPath(''), '');
    const ok = (data: unknown) => ({ status: 200, data: data as T });
    if (method === 'GET' && short === '/pulls/9' && this.gone) return { status: 404, data: null as T };
    if (method === 'GET' && short === '/pulls/9') {
      return ok({ title: 'A change', body: 'What it does.', head: { sha: this.head }, changed_files: this.files.length });
    }
    if (method === 'GET' && short.startsWith('/pulls/9/files')) {
      if (this.filesStatus !== 200) return { status: this.filesStatus, data: { message: 'Sorry, the diff exceeded the maximum number of files' } as T };
      // As GitHub lists them: 100 a page, 3,000 at most, and 200 all the same past them.
      const page = Number(/[?&]page=(\d+)/.exec(short)?.[1] ?? 1);
      return ok(this.files.slice(0, 3_000).slice((page - 1) * 100, page * 100));
    }
    if (method === 'GET' && short.startsWith('/contents/')) {
      const file = decodeURIComponent(short.slice('/contents/'.length).split('?')[0] ?? '');
      return file === real.path
        ? ok({ type: 'file', encoding: 'base64', content: Buffer.from(real.content).toString('base64') })
        : { status: 404, data: null as T };
    }
    if (method === 'POST' && short === '/pulls/9/reviews') {
      this.posted.push(body as Posted);
      return { status: this.reviewAnswers.shift() ?? 200, data: null as T };
    }
    throw new Error(`unexpected ${method} ${short}`);
  }
}

interface Proposed {
  line: number;
  severity: 'high' | 'medium' | 'low';
  title: string;
}

/**
 * A relay whose finders propose `findings` (the deep model only, so each is proposed once) and whose
 * verifier keeps every candidate whose title does not say "reject". `fail` throws for a call it names.
 */
class FakeRelay implements Relay {
  readonly calls: { model: string; effort: string | null; verify: boolean; user: string }[] = [];
  findings: Proposed[] = [];
  fail: (req: JsonRequest, n: number) => RelayError | null = () => null;
  /** What a search answers instead of its findings, call by call: valid JSON off the schema. */
  offSchema: ((n: number) => unknown) | null = null;
  /** The model whose verifications answer `{}`, valid JSON off the schema. */
  offSchemaVerifier: string | null = null;

  async json<T>(req: JsonRequest): Promise<JsonAnswer<T>> {
    const verify = req.schema === VERDICTS_SCHEMA;
    this.calls.push({ model: req.model, effort: req.effort, verify, user: req.user });
    const error = this.fail(req, this.calls.length);
    if (error) throw error;
    const done = (value: unknown) => ({ value: value as T, usage: { prompt: 100, completion: 10, reasoning: 5 }, model: req.model, ms: 1000 });
    if (!verify) {
      if (this.offSchema) return done(this.offSchema(this.calls.length));
      const findings = req.model === DEEP.id && !req.system.includes('across files') ? this.findings : [];
      return done({
        findings: findings.map((f) => ({ path: real.path, category: 'logic', explanation: `Because ${f.title}.`, fix: 'Fix it.', ...f })),
      });
    }
    if (req.model === this.offSchemaVerifier) return done({});
    const candidates = JSON.parse(req.user.slice(req.user.indexOf('[', req.user.indexOf('===== CANDIDATE FINDINGS')))) as (Proposed & { id: number })[];
    // A candidate whose title says "passed over" gets no verdict, as a verifier may forget one; one that
    // says "no keep" a verdict with neither a yes nor a no.
    const judged = candidates.filter((c) => !c.title.includes('passed over'));
    return done({
      verdicts: judged.map((c) => (c.title.includes('no keep') ? { ...c, reason: 'traced' } : { ...c, keep: !c.title.includes('reject'), reason: 'traced' })),
    });
  }
}

const options: ReviewOptions = { clock: () => 0 };
const review = (gh: FakeRepo, relay: Relay, opts = options) => reviewWithLovable(gh, relay, { number: 9, head: HEAD, why: 'crédits épuisés' }, opts);

describe('the Lovable review', () => {
  it('opens a thread on each verified finding, at the line it cites, and nothing for a rejected one', async () => {
    const gh = new FakeRepo();
    const relay = new FakeRelay();
    relay.findings = [
      { line: ADDED[0]!, severity: 'high', title: 'a real defect' },
      { line: ADDED[1]!, severity: 'medium', title: 'please reject me' },
      { line: ADDED[2]!, severity: 'low', title: 'a minor one' },
    ];
    const outcome = await review(gh, relay);
    assert.deepEqual(outcome.kind === 'reviewed' && outcome.threads, 1);
    const posted = gh.posted[0];
    assert.ok(posted);
    assert.ok(posted.body.startsWith(`${LOVABLE_MARK} head=${HEAD} -->`), 'the gate reads its own review back by this marker');
    assert.deepEqual(posted.comments.map((c) => [c.path, c.line, c.side]), [[real.path, ADDED[0], 'RIGHT']]);
    assert.match(posted.comments[0]?.body ?? '', /a real defect/);
    assert.match(posted.body, /a minor one/, 'a minor finding goes into the body');
    assert.doesNotMatch(JSON.stringify(posted), /please reject me/);
    // Every chunk by the two families and the third reader; the lock file is never read.
    assert.deepEqual(new Set(relay.calls.filter((c) => !c.verify).map((c) => c.model)), new Set([DEEP.id, WIDE.id, SECOND.id]));
    assert.match(posted.body, /pnpm-lock\.yaml/);
    // Named to the models, so that none reports a lock file or a build as not updated (seen on merge-gate #5).
    assert.ok(relay.calls.every((c) => /not shown here .*: pnpm-lock\.yaml \(modified\)/.test(c.user)));
  });

  it('moves a line cited just off the diff onto the diff, and one far from it into the body', async () => {
    const gh = new FakeRepo();
    const relay = new FakeRelay();
    const near = Math.max(...ann.commentable) + 1; // just past the last hunk
    const far = Math.max(...ann.commentable) + 50;
    relay.findings = [
      { line: near, severity: 'high', title: 'just off' },
      { line: far, severity: 'high', title: 'far away' },
    ];
    await review(gh, relay);
    const [posted] = gh.posted;
    assert.deepEqual(posted?.comments.map((c) => c.line), [anchor(near, ann)]);
    assert.ok(ann.commentable.has(posted?.comments[0]?.line ?? 0));
    assert.match(posted?.body ?? '', /far away/);
  });

  it('when GitHub refuses a comment’s line (422): the context-line threads go into the body, then every thread', async () => {
    const gh = new FakeRepo();
    gh.reviewAnswers = [422, 422];
    const relay = new FakeRelay();
    relay.findings = [
      { line: ADDED[0]!, severity: 'high', title: 'on an added line' },
      { line: CONTEXT[0]!, severity: 'high', title: 'on a context line' },
    ];
    const outcome = await review(gh, relay);
    assert.deepEqual(gh.posted.map((p) => p.comments.length), [2, 1, 0]);
    assert.match(gh.posted[1]?.body ?? '', /on a context line/);
    assert.match(gh.posted[2]?.body ?? '', /on an added line/);
    assert.deepEqual(outcome.kind === 'reviewed' && outcome.threads, 0);
  });

  it('stops at the first answer that says no credit, and posts nothing', async () => {
    const gh = new FakeRepo();
    const relay = new FakeRelay();
    relay.fail = () => new RelayError('credits', 402, 'relais 402');
    const outcome = await review(gh, relay);
    assert.deepEqual(outcome.kind === 'failed' && outcome.failure, 'credits');
    assert.equal(gh.posted.length, 0);
    // The calls already started when the first 402 came back, and no other.
    assert.ok(relay.calls.length <= 3, String(relay.calls.length));
  });

  it('asks again one effort lower when a call times out, and starts lower once a model timed out twice', async () => {
    const gh = new FakeRepo();
    // A second file, so the deep model also reads the whole diff: three of its calls in a row.
    gh.files.push({ filename: 'src/extra.ts', status: 'added', patch: '@@ -0,0 +1,2 @@\n+export const a = 1;\n+export const b = 2;' });
    const relay = new FakeRelay();
    relay.findings = [{ line: ADDED[0]!, severity: 'high', title: 'a real defect' }];
    relay.fail = (req) => (req.model === DEEP.id && req.effort === 'high' ? new RelayError('timeout', 524, 'relais 524') : null);
    const outcome = await review(gh, relay, { ...options, limits: { concurrency: 1 } });
    assert.equal(outcome.kind, 'reviewed');
    const deep = relay.calls.filter((c) => c.model === DEEP.id).map((c) => c.effort);
    // The chunk, then the whole diff: high times out twice, medium answers; the verification starts at medium.
    assert.deepEqual(deep, ['high', 'medium', 'high', 'medium', 'medium']);
  });

  it('when the verifier never judged them: an important candidate still gets its thread, said unverified; a medium one is listed', async () => {
    const gh = new FakeRepo();
    const relay = new FakeRelay();
    relay.findings = [
      { line: ADDED[0]!, severity: 'high', title: 'unjudged high' },
      { line: ADDED[1]!, severity: 'medium', title: 'unjudged medium' },
    ];
    relay.fail = (req) => (req.schema === VERDICTS_SCHEMA ? new RelayError('error', 500, 'relais 500') : null);
    const outcome = await review(gh, relay);
    assert.equal(outcome.kind, 'reviewed');
    const [posted] = gh.posted;
    assert.deepEqual(posted?.comments.map((c) => c.line), [ADDED[0]]);
    assert.match(posted?.comments[0]?.body ?? '', /unjudged high\*\* · importante · non vérifiée/);
    assert.match(posted?.body ?? '', /Non vérifiées[\s\S]*unjudged medium/);
  });

  it('a candidate the verifier passed over stands unverified, not rejected: an important one in a thread, a medium one listed', async () => {
    const gh = new FakeRepo();
    const relay = new FakeRelay();
    relay.findings = [
      { line: ADDED[0]!, severity: 'high', title: 'passed over high' },
      { line: ADDED[1]!, severity: 'medium', title: 'passed over medium' },
      { line: ADDED[2]!, severity: 'high', title: 'reject this one' },
      { line: ADDED[1]!, severity: 'medium', title: 'no keep medium' },
    ];
    const outcome = await review(gh, relay);
    assert.equal(outcome.kind, 'reviewed');
    const [posted] = gh.posted;
    assert.deepEqual(posted?.comments.map((c) => c.line), [ADDED[0]]);
    assert.match(posted?.comments[0]?.body ?? '', /passed over high\*\* · importante · non vérifiée/);
    assert.match(posted?.body ?? '', /Non vérifiées[\s\S]*passed over medium/);
    assert.match(posted?.body ?? '', /Non vérifiées[\s\S]*no keep medium/, 'a verdict without a yes or a no rejects nothing');
    assert.match(posted?.body ?? '', /0 retenue\(s\) et 1 écartée\(s\) à la vérification, 3 non vérifiée\(s\)/);
  });

  it('two findings on one line: the most severe opens the thread, the other goes into the body', async () => {
    const gh = new FakeRepo();
    const relay = new FakeRelay();
    relay.findings = [
      { line: ADDED[0]!, severity: 'medium', title: 'second on the line' },
      { line: ADDED[0]!, severity: 'high', title: 'first on the line' },
    ];
    await review(gh, relay);
    const [posted] = gh.posted;
    assert.deepEqual(posted?.comments.map((c) => c.line), [ADDED[0]]);
    assert.match(posted?.comments[0]?.body ?? '', /first on the line/);
    assert.match(posted?.body ?? '', /Hors fil[\s\S]*second on the line/);
  });

  it('stopped halfway by no credit: posts what it found for information, without the mark, and fails', async () => {
    const gh = new FakeRepo();
    const relay = new FakeRelay();
    relay.findings = [{ line: ADDED[0]!, severity: 'high', title: 'found before the stop' }];
    // The deep model answers the one chunk, then every call says no credit: no verification runs.
    relay.fail = (_req, n) => (n > 1 ? new RelayError('credits', 402, 'relais 402') : null);
    const outcome = await review(gh, relay, { ...options, limits: { concurrency: 1 } });
    assert.deepEqual(outcome.kind === 'failed' && [outcome.failure, outcome.threads], ['credits', 1]);
    const [posted] = gh.posted;
    assert.ok(posted && !posted.body.includes(LOVABLE_MARK), 'not counted as the pull request’s review');
    assert.match(posted?.body ?? '', /^### Relecture Lovable interrompue/);
    assert.match(posted?.comments[0]?.body ?? '', /found before the stop[\s\S]*non vérifiée/);
  });

  it('stopped halfway with a file unread: names it, and does not say the review counts', async () => {
    const gh = new FakeRepo();
    // A second chunk, after the real file's in path order; every call that shows it says no credit.
    const lines = Array.from({ length: 800 }, (_, i) => `+export const a${i} = ${i};`);
    gh.files.push({ filename: 'src/zz-extra.ts', status: 'added', patch: `@@ -0,0 +1,800 @@\n${lines.join('\n')}` });
    const relay = new FakeRelay();
    relay.findings = [{ line: ADDED[0]!, severity: 'high', title: 'found before the stop' }];
    relay.fail = (req) => (req.user.includes('export const a799') ? new RelayError('credits', 402, 'relais 402') : null);
    const outcome = await review(gh, relay, { ...options, limits: { concurrency: 1 } });
    assert.equal(outcome.kind === 'failed' && outcome.failure, 'credits');
    const body = gh.posted[0]?.body ?? '';
    assert.match(body, /#### Non relus \(relais arrêté avant leur lecture\)\n- `src\/zz-extra\.ts`/);
    assert.doesNotMatch(body, /compte quand même/);
  });

  it('fails, rather than review an empty pull request, when GitHub will not list its files', async () => {
    const gh = new FakeRepo();
    gh.filesStatus = 422;
    const relay = new FakeRelay();
    await assert.rejects(review(gh, relay), /fichiers de la PR refusés par GitHub \(422\)/);
    assert.equal(relay.calls.length, 0);
    assert.equal(gh.posted.length, 0);
  });

  it('fails, rather than leave files out unnamed, when GitHub lists fewer files than the pull request changes', async () => {
    const gh = new FakeRepo();
    for (let i = 0; i < 3_000; i++) gh.files.push({ filename: `src/f${i}.ts`, status: 'added', patch: '@@ -0,0 +1 @@\n+x' });
    const relay = new FakeRelay();
    await assert.rejects(review(gh, relay), /liste des fichiers incomplète \(3000 sur 3002\)/);
    assert.equal(relay.calls.length, 0);
    assert.equal(gh.posted.length, 0);
  });

  it('counts a search answered off the schema as failed, not as one that found nothing', async () => {
    const gh = new FakeRepo();
    const relay = new FakeRelay();
    relay.findings = [{ line: ADDED[0]!, severity: 'high', title: 'never seen' }];
    relay.offSchema = (n) => [{}, { findings: null }, null][n % 3];
    const outcome = await review(gh, relay);
    assert.equal(outcome.kind === 'failed' && outcome.failure, 'unavailable');
    assert.equal(gh.posted.length, 0, 'no review says the pull request was read');
  });

  it('asks the other family when a verification comes back off the schema, as after a failed call', async () => {
    const gh = new FakeRepo();
    const relay = new FakeRelay();
    relay.findings = [
      { line: ADDED[0]!, severity: 'high', title: 'a real defect' },
      { line: ADDED[1]!, severity: 'medium', title: 'please reject me' },
    ];
    relay.offSchemaVerifier = DEEP.id;
    const outcome = await review(gh, relay);
    assert.equal(outcome.kind === 'reviewed' && outcome.threads, 1);
    const [posted] = gh.posted;
    assert.doesNotMatch(posted?.comments[0]?.body ?? '', /non vérifiée/, 'judged by the other family');
    assert.doesNotMatch(JSON.stringify(posted), /please reject me/);
    assert.ok(relay.calls.some((c) => c.verify && c.model === WIDE.id));
  });

  it('names the files no model could read', async () => {
    const gh = new FakeRepo();
    // A file too big to share a chunk with the other: two chunks, and every call on this one fails.
    const lines = Array.from({ length: 800 }, (_, i) => `+export const a${i} = ${i};`);
    gh.files.push({ filename: 'src/extra.ts', status: 'added', patch: `@@ -0,0 +1,800 @@\n${lines.join('\n')}` });
    const relay = new FakeRelay();
    relay.findings = [{ line: ADDED[0]!, severity: 'high', title: 'a real defect' }];
    relay.fail = (req) => (req.schema !== VERDICTS_SCHEMA && req.user.includes('export const a799') ? new RelayError('error', 500, 'relais 500') : null);
    const outcome = await review(gh, relay);
    assert.equal(outcome.kind === 'reviewed' && outcome.threads, 1);
    assert.match(gh.posted[0]?.body ?? '', /#### Non relus[^\n]*\n- `src\/extra\.ts`/);
    assert.doesNotMatch(gh.posted[0]?.body ?? '', new RegExp(`Non relus[^#]*${real.path}`));
  });

  it('keeps a review with many findings under the size GitHub accepts', async () => {
    const gh = new FakeRepo();
    const relay = new FakeRelay();
    relay.findings = Array.from({ length: 60 }, (_, i) => ({ line: ADDED[0]!, severity: 'low' as const, title: `minor ${i} ${'x'.repeat(2_000)}` }));
    const outcome = await review(gh, relay);
    assert.equal(outcome.kind, 'reviewed');
    const body = gh.posted[0]?.body ?? '';
    assert.ok(body.length < 65_536, String(body.length));
    assert.match(body, /de plus, coupée\(s\) : GitHub limite la taille d’une revue/);
  });

  it('posts nothing when the head moved during the review, or the pull request no longer answers', async () => {
    for (const move of [(gh: FakeRepo) => (gh.head = 'd'.repeat(40)), (gh: FakeRepo) => (gh.gone = true)]) {
      const gh = new FakeRepo();
      const relay = new FakeRelay();
      relay.findings = [{ line: ADDED[0]!, severity: 'high', title: 'a real defect' }];
      relay.fail = () => {
        move(gh);
        return null;
      };
      assert.deepEqual(await review(gh, relay), { kind: 'moved' });
      assert.ok(relay.calls.length > 0);
      assert.equal(gh.posted.length, 0);
    }
  });

  it('reads nothing and asks nothing when the head moved: the next run reviews the new one', async () => {
    const gh = new FakeRepo();
    gh.head = 'd'.repeat(40);
    const relay = new FakeRelay();
    assert.deepEqual(await review(gh, relay), { kind: 'moved' });
    assert.equal(relay.calls.length, 0);
    assert.equal(gh.posted.length, 0);
  });

  it('fails as unavailable when no search could start in time', async () => {
    const gh = new FakeRepo();
    const relay = new FakeRelay();
    let t = 0;
    const outcome = await review(gh, relay, { clock: () => (t += 10 * 60_000) });
    assert.deepEqual(outcome.kind === 'failed' && outcome.failure, 'unavailable');
    assert.equal(relay.calls.length, 0);
  });

  it('posts a review that says so when only machine-written files changed', async () => {
    const gh = new FakeRepo();
    gh.files = gh.files.filter((f) => f.filename === 'pnpm-lock.yaml');
    const relay = new FakeRelay();
    const outcome = await review(gh, relay);
    assert.equal(outcome.kind, 'reviewed');
    assert.equal(relay.calls.length, 0);
    assert.match(gh.posted[0]?.body ?? '', /Rien à relire/);
  });
});
