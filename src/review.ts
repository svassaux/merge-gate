import { anchor, annotate, numbered, pack, reviewable, type Annotated, type FileDiff, type Unit } from './diff.ts';
import type { Api } from './github.ts';
import { LOVABLE_MARK, type LovableFailure } from './model.ts';
import {
  CROSS_SYSTEM,
  crossPrompt,
  FINDER_SYSTEM,
  finderPrompt,
  FINDINGS_SCHEMA,
  VERDICTS_SCHEMA,
  VERIFIER_SYSTEM,
  verifierPrompt,
  type CandidateText,
  type ChunkText,
  type PullRequestText,
  type Severity,
} from './prompts.ts';
import { RelayError, type Effort, type JsonAnswer, type Relay, type RelayFailure } from './relay.ts';

/**
 * The review the gate has the Lovable relay write when Copilot cannot: the most a relay call allows,
 * many times over. Every changed file is read in chunks that fit one call, with its whole content; each
 * chunk by two models of two families, then by a third while time remains; the whole diff once more
 * for what only shows across files; and every candidate is checked against the code by a verifier
 * before it becomes a thread — an important one time left unjudged still gets its thread, said
 * unverified. What a model cites is anchored on a line GitHub accepts, or goes into the review's body.
 */

export interface ModelSpec {
  id: string;
  label: string;
  /** Efforts tried in turn: a call that times out at one is asked again at the next. */
  ladder: readonly Effort[];
}

/**
 * The models, measured through the relay on 2026-11-19 on the same 2,400-token file: GPT-6.1 terra
 * thought 2,200 tokens at `high` in 40 s, GPT-6.1 sol 2,000 in 60 s, GPT-6 astra 2,200 in 78 s;
 * Gemini 4 argon answered in 9 to 11 s at `medium` or `low` and never within the relay's 126 s at
 * `high`; Gemini 3.8 Flash, the relay's default elsewhere, timed out on that review at every effort.
 */
export const DEEP: ModelSpec = { id: 'openai/gpt-6.1-terra', label: 'GPT-6.1 terra', ladder: ['high', 'medium', 'low'] };
export const SECOND: ModelSpec = { id: 'openai/gpt-6.1-sol', label: 'GPT-6.1 sol', ladder: ['high', 'medium', 'low'] };
export const WIDE: ModelSpec = { id: 'google/gemini-4-argon', label: 'Gemini 4 argon', ladder: ['medium', null] };

export interface Limits {
  /** Characters of diff and content in one chunk. */
  chunk: number;
  /** Characters of diff the cross-file pass reads. */
  cross: number;
  /** Relay calls at once: Lovable's terms ask for moderate, personal rates. */
  concurrency: number;
  /** From the start of the review: no search call starts past this, no verification call past `verify`. */
  find: number;
  verify: number;
  /** Threads one review opens at most; the rest goes into its body. */
  threads: number;
  /** Candidates one verification call judges. */
  batch: number;
}

export const LIMITS: Limits = {
  chunk: 36_000,
  cross: 90_000,
  concurrency: 3,
  find: 6 * 60_000,
  verify: 12 * 60_000,
  threads: 25,
  batch: 10,
};

/** The repository's instructions to reviewers and agents, read at the head, each cut to this size. */
const GUIDANCE_FILES = ['.github/copilot-instructions.md', 'AGENTS.md', 'CLAUDE.md'];
const GUIDANCE_MAX = 12_000;
/** A file longer than this goes without its content. */
const CONTENT_MAX = 150_000;
/** `GET /pulls/{n}/files` lists 3,000 files at most, 100 a page. */
const FILE_PAGES = 30;

export type LovableOutcome =
  /** The review is posted; `threads` of its findings opened a thread each. */
  | { kind: 'reviewed'; threads: number; line: string }
  /**
   * No review: the relay could not give one. When it stopped halfway (no credit, token refused), what it
   * had found may be posted for information, without counting as the review: `threads` it opened.
   */
  | { kind: 'failed'; failure: LovableFailure; threads: number; line: string }
  /** The head moved while the gate read it: nothing is posted, the run for the new head reviews it. */
  | { kind: 'moved' };

interface Finding {
  path: string;
  line: number;
  severity: Severity;
  category: string;
  title: string;
  explanation: string;
  fix: string;
}

interface Candidate extends Finding {
  id: number;
  by: string;
}

interface Final extends Finding {
  by: string;
  verified: boolean;
}

interface Reviewed {
  path: string;
  ann: Annotated;
}

interface Gathered {
  text: PullRequestText;
  reviewed: Reviewed[];
  units: Unit[];
  skipped: string[];
}

/** A text file at `ref`, or null: absent, binary, or over the contents API's 1 MB. */
export async function readText(gh: Api, path: string, ref: string): Promise<string | null> {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const res = await gh.rest<{ type?: string; encoding?: string; content?: string } | null>('GET', gh.repoPath(`/contents/${encoded}?ref=${ref}`));
  if (res.status !== 200 || res.data?.type !== 'file' || res.data.encoding !== 'base64' || !res.data.content) return null;
  const text = Buffer.from(res.data.content, 'base64').toString('utf8');
  return text.includes('\u0000') ? null : text;
}

/** Runs `work` over `items`, `n` at a time. */
async function each<T>(items: readonly T[], n: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

async function gather(gh: Api, number: number, head: string): Promise<Gathered | null> {
  const pr = await gh.rest<{ title?: string; body?: string | null; head?: { sha?: string }; changed_files?: number } | null>(
    'GET',
    gh.repoPath(`/pulls/${number}`),
  );
  if (pr.status !== 200 || pr.data?.head?.sha !== head) return null;
  const files: FileDiff[] = [];
  for (let page = 1; page <= FILE_PAGES; page++) {
    const res = await gh.rest<{ filename: string; status: string; patch?: string }[]>(
      'GET',
      gh.repoPath(`/pulls/${number}/files?per_page=100&page=${page}`),
    );
    // An outage or a rate limit throws in the client; a list GitHub will not give (a 422) is no review of
    // an empty pull request either: the relay's failure, said in the note.
    if (res.status !== 200 || !Array.isArray(res.data)) throw new Error(`fichiers de la PR refusés par GitHub (${res.status})`);
    const listed = res.data;
    files.push(...listed.map((f) => ({ path: f.filename, status: f.status, patch: f.patch ?? null })));
    if (listed.length < 100) break;
  }
  // GitHub lists 3,000 files at most, answering 200 all the same: the files past them would be neither
  // read nor named as unread, under a mark that says the pull request was reviewed.
  const expected = pr.data?.changed_files;
  if (typeof expected === 'number' && files.length < expected) throw new Error(`liste des fichiers incomplète (${files.length} sur ${expected})`);
  const kept = files.filter(reviewable);
  const skipped = files.filter((f) => !reviewable(f)).map((f) => f.path);
  const contents = new Map<string, string | null>();
  await each(kept, 6, async (f) => {
    const text = await readText(gh, f.path, head);
    contents.set(f.path, text !== null && text.length <= CONTENT_MAX ? numbered(text) : null);
  });
  const guidance: string[] = [];
  for (const path of GUIDANCE_FILES) {
    const text = await readText(gh, path, head);
    if (text?.trim()) guidance.push(`--- ${path}${text.length > GUIDANCE_MAX ? ' (cut)' : ''} ---\n${text.slice(0, GUIDANCE_MAX)}`);
  }
  const reviewed = kept.map((f) => ({ path: f.path, ann: annotate(f.patch ?? '') }));
  return {
    text: {
      repository: `${gh.owner}/${gh.repo}`,
      title: pr.data.title ?? '',
      description: pr.data.body ?? '',
      guidance: guidance.join('\n\n'),
      unshown: files.filter((f) => !reviewable(f)).map((f) => `${f.path} (${f.status})`),
    },
    reviewed,
    units: reviewed.map((r) => ({ path: r.path, diff: r.ann.text, content: contents.get(r.path) ?? null })),
    skipped,
  };
}

/** The new-file lines a unit's diff shows, read back from its annotation. */
function unitLines(u: Unit): Set<number> {
  return new Set([...u.diff.matchAll(/^ *(\d+) [+ ] /gm)].map((m) => Number(m[1])));
}

const SEVERITIES: readonly Severity[] = ['high', 'medium', 'low'];
const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** A model's finding, or null when it lacks what a thread needs. */
function asFinding(raw: unknown): Finding | null {
  const f = raw as Partial<Record<keyof Finding, unknown>> | null;
  if (!f || typeof f.path !== 'string' || typeof f.title !== 'string' || typeof f.explanation !== 'string') return null;
  const line = Number(f.line);
  if (!Number.isInteger(line) || line < 1 || !f.title.trim()) return null;
  return {
    path: f.path.trim().replace(/^\.?\//, ''),
    line,
    severity: SEVERITIES.includes(f.severity as Severity) ? (f.severity as Severity) : 'medium',
    category: typeof f.category === 'string' ? f.category : '',
    title: f.title.trim(),
    explanation: f.explanation.trim(),
    fix: typeof f.fix === 'string' ? f.fix.trim() : '',
  };
}

interface Tally {
  calls: number;
  ok: number;
  failures: Partial<Record<RelayFailure, number>>;
  prompt: number;
  completion: number;
  reasoning: number;
  /** Model as the gateway named it → effort it answered at. */
  answered: Map<string, Set<string>>;
}

/** The calls of one review: the effort ladder, the shared stop on no credit or a refused token, the tally. */
class Session {
  readonly tally: Tally = { calls: 0, ok: 0, failures: {}, prompt: 0, completion: 0, reasoning: 0, answered: new Map() };
  fatal: RelayError | null = null;
  readonly #relay: Relay;
  readonly #clock: () => number;
  readonly #log: (line: string) => void;
  readonly #concurrency: number;
  /** Per model, the rung its calls start at: lowered after two timeouts at one rung. */
  readonly #start = new Map<string, number>();
  readonly #timeouts = new Map<string, number>();

  constructor(relay: Relay, clock: () => number, log: (line: string) => void, concurrency: number) {
    this.#relay = relay;
    this.#clock = clock;
    this.#log = log;
    this.#concurrency = concurrency;
  }

  /** One answer from `spec`, down its effort ladder; null when every rung failed or time ran out. */
  async ask<T>(spec: ModelSpec, task: string, system: string, user: string, schema: object, deadline: number): Promise<JsonAnswer<T> | null> {
    for (let rung = this.#start.get(spec.id) ?? 0; rung < spec.ladder.length; rung++) {
      if (this.fatal || this.#clock() >= deadline) return null;
      const effort = spec.ladder[rung] ?? null;
      this.tally.calls++;
      try {
        const a = await this.#relay.json<T>({ model: spec.id, effort, system, user, schema });
        this.tally.ok++;
        this.tally.prompt += a.usage.prompt;
        this.tally.completion += a.usage.completion;
        this.tally.reasoning += a.usage.reasoning;
        const efforts = this.tally.answered.get(a.model) ?? new Set();
        efforts.add(effort ?? 'défaut');
        this.tally.answered.set(a.model, efforts);
        this.#log(`  ${task} · ${spec.label} ${effort ?? 'défaut'} → ${Math.round(a.ms / 1000)} s, ${a.usage.prompt} → ${a.usage.completion} jetons`);
        return a;
      } catch (err) {
        const e = err instanceof RelayError ? err : new RelayError('error', 0, err instanceof Error ? err.message : String(err));
        this.tally.failures[e.kind] = (this.tally.failures[e.kind] ?? 0) + 1;
        this.#log(`  ${task} · ${spec.label} ${effort ?? 'défaut'} → ${e.kind} (${e.message})`);
        if (e.kind === 'credits' || e.kind === 'token') {
          this.fatal = e;
          return null;
        }
        if (e.kind === 'rate') return null;
        if (e.kind === 'timeout') {
          const key = `${spec.id}#${rung}`;
          const n = (this.#timeouts.get(key) ?? 0) + 1;
          this.#timeouts.set(key, n);
          if (n >= 2 && (this.#start.get(spec.id) ?? 0) <= rung) this.#start.set(spec.id, rung + 1);
        }
      }
    }
    return null;
  }

  /** Runs the tasks in order, a few at a time; none starts past `deadline` or after a fatal answer. */
  async run(tasks: (() => Promise<void>)[], deadline: number): Promise<number> {
    let started = 0;
    await each(tasks, this.#concurrency, async (task) => {
      if (this.fatal || this.#clock() >= deadline) return;
      started++;
      await task();
    });
    return started;
  }
}

const SEVERITY_LABEL: Record<Severity, string> = { high: 'importante', medium: 'moyenne', low: 'mineure' };

/** GitHub refuses (422) a review whose body or comment passes 65,536 characters: each part is cut well below. */
const COMMENT_MAX = 8_000;
const ITEM_MAX = 1_500;
const LIST_MAX = 15_000;

const cut = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** The items that fit in `max` characters, then one line saying how many were cut. */
function fit(items: string[], max: number): string[] {
  const kept: string[] = [];
  let size = 0;
  for (const [i, item] of items.entries()) {
    if (size + item.length + 1 > max) {
      kept.push(`- … et ${items.length - i} de plus, coupée(s) : GitHub limite la taille d’une revue.`);
      break;
    }
    kept.push(item);
    size += item.length + 1;
  }
  return kept;
}

function commentBody(f: Final): string {
  return cut(
    [
      `**${f.title}** · ${SEVERITY_LABEL[f.severity]}${f.verified ? '' : ' · non vérifiée (temps ou relais épuisé avant la vérification)'}`,
      '',
      f.explanation,
      ...(f.fix ? ['', `**Correctif proposé** : ${f.fix}`] : []),
      '',
      `<sub>Relecture Lovable · ${f.by}${f.category ? ` · ${f.category}` : ''}</sub>`,
    ].join('\n'),
    COMMENT_MAX,
  );
}

const listItem = (f: Final) =>
  cut(
    `- \`${f.path}:${f.line}\` — **${f.title}** (${SEVERITY_LABEL[f.severity]}${f.verified ? '' : ', non vérifiée'}). ${f.explanation}${f.fix ? ` *Correctif proposé :* ${f.fix}` : ''}`,
    ITEM_MAX,
  );

type Thread = Final & { onAdded: boolean };

/**
 * Post the review. GitHub refuses the whole review (422) when one comment's line does not resolve in
 * the diff: the comments on context lines then go into the body, then all of them. Returns how many
 * threads the posted review opened.
 */
async function post(gh: Api, number: number, head: string, threads: Thread[], body: (inBody: Final[]) => string): Promise<number> {
  const strict = threads.filter((t) => t.onAdded);
  const attempts = [threads, ...(strict.length < threads.length ? [strict] : []), ...(threads.length > 0 ? [[]] : [])];
  for (const posted of attempts) {
    const res = await gh.rest('POST', gh.repoPath(`/pulls/${number}/reviews`), {
      commit_id: head,
      event: 'COMMENT',
      body: body(threads.filter((t) => !posted.includes(t))),
      comments: posted.map((t) => ({ path: t.path, line: t.line, side: 'RIGHT', body: commentBody(t) })),
    });
    if (res.status === 200 || res.status === 201) return posted.length;
    if (res.status !== 422) throw new Error(`POST /pulls/${number}/reviews: ${res.status}`);
  }
  throw new Error(`POST /pulls/${number}/reviews: 422`);
}

export interface ReviewInput {
  number: number;
  head: string;
  /** Why Copilot did not review, as the gate words it. */
  why: string;
}

export interface ReviewOptions {
  clock?: () => number;
  log?: (line: string) => void;
  limits?: Partial<Limits>;
}

const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;

/** Has the relay review the pull request's head, and posts that review. */
export async function reviewWithLovable(gh: Api, relay: Relay, input: ReviewInput, opts: ReviewOptions = {}): Promise<LovableOutcome> {
  const clock = opts.clock ?? Date.now;
  const log = opts.log ?? (() => undefined);
  const limits = { ...LIMITS, ...opts.limits };
  const t0 = clock();
  const g = await gather(gh, input.number, input.head);
  if (!g) return { kind: 'moved' };

  const chunks = pack(g.units, limits.chunk);
  const allFiles = g.reviewed.map((r) => r.path);
  const chunkTexts: ChunkText[] = chunks.map((units, i) => ({ part: `part ${i + 1} of ${chunks.length}`, allFiles, files: units }));
  const session = new Session(relay, clock, log, limits.concurrency);
  log(`Lovable : ${g.reviewed.length} fichier(s) en ${chunks.length} lot(s), ${g.skipped.length} ignoré(s)`);

  // Search: each chunk by two families, the whole diff once, then a third reader while time remains.
  const candidates: Candidate[] = [];
  let finders = 0;
  /** The chunks at least one model read: the files of any other go into the review as not read. */
  const read = new Set<number>();
  const find = (spec: ModelSpec, task: string, system: string, user: string, chunk: number | null) => async () => {
    const a = await session.ask<{ findings?: unknown[] } | null>(spec, task, system, user, FINDINGS_SCHEMA, t0 + limits.find);
    // Only a list of findings is a search done, an empty one included: an answer off the schema read nothing.
    const found = a?.value?.findings;
    if (!Array.isArray(found)) {
      if (a) log(`  ${task} : réponse hors schéma, comptée comme un échec`);
      return;
    }
    finders++;
    if (chunk !== null) read.add(chunk);
    for (const raw of found) {
      const f = asFinding(raw);
      if (f) candidates.push({ ...f, id: candidates.length + 1, by: spec.label });
    }
  };
  const searches: (() => Promise<void>)[] = [];
  chunkTexts.forEach((c, i) => {
    const user = finderPrompt(g.text, c);
    searches.push(find(DEEP, `lot ${i + 1}`, FINDER_SYSTEM, user, i), find(WIDE, `lot ${i + 1}`, FINDER_SYSTEM, user, i));
    if (i === 0 && g.reviewed.length > 1) {
      const per = Math.floor(limits.cross / g.reviewed.length);
      const cutDiffs = g.reviewed.some((r) => r.ann.text.length > per);
      const diffs = g.reviewed.map((r) => ({ path: r.path, diff: r.ann.text.length > per ? `${r.ann.text.slice(0, per)}\n[… cut]` : r.ann.text }));
      searches.push(find(DEEP, 'transversal', CROSS_SYSTEM, crossPrompt(g.text, diffs, cutDiffs), null));
    }
  });
  chunkTexts.forEach((c, i) => searches.push(find(SECOND, `lot ${i + 1}`, FINDER_SYSTEM, finderPrompt(g.text, c), i)));
  const searched = await session.run(searches, t0 + limits.find);

  if (chunks.length > 0 && finders === 0) {
    const failure: LovableFailure = session.fatal?.kind === 'credits' ? 'credits' : session.fatal?.kind === 'token' ? 'token' : 'unavailable';
    return { kind: 'failed', failure, threads: 0, line: `relecture Lovable impossible (${failure}) après ${session.tally.calls} appel(s), ${seconds(clock() - t0)}` };
  }

  // Verification: every candidate against the code of its chunk, by the deep model, else the other
  // family. A model may cite a file outside the chunk it read: it is judged with the chunk that holds it.
  const lines = chunks.map((units) => units.map((u) => ({ path: u.path, lines: unitLines(u) })));
  const chunkOf = (c: Candidate) => {
    const exact = lines.findIndex((us) => us.some((u) => u.path === c.path && u.lines.has(c.line)));
    return exact >= 0 ? exact : lines.findIndex((us) => us.some((u) => u.path === c.path));
  };
  const byChunk = new Map<number, Candidate[]>();
  let strays = 0;
  for (const c of candidates) {
    const i = chunkOf(c);
    if (i < 0) strays++;
    else byChunk.set(i, [...(byChunk.get(i) ?? []), c]);
  }
  const finals: Final[] = [];
  const unverified: Candidate[] = [];
  let rejected = 0;
  const batches: { chunk: number; list: Candidate[]; judged: boolean }[] = [];
  for (const [i, list] of [...byChunk.entries()].sort((a, b) => a[0] - b[0])) {
    // Sorted by place, so that duplicates of one defect land in the same batch and the verifier merges them.
    const sorted = list.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    for (let k = 0; k < sorted.length; k += limits.batch) batches.push({ chunk: i, list: sorted.slice(k, k + limits.batch), judged: false });
  }
  const verify = (b: (typeof batches)[number]) => async () => {
    const texts: CandidateText[] = b.list.map(({ by: _, ...c }) => c);
    const user = verifierPrompt(g.text, chunkTexts[b.chunk] as ChunkText, texts);
    const deadline = t0 + limits.verify;
    const task = `vérif. lot ${b.chunk + 1}`;
    // An answer off the schema judged nothing: the other family is asked, as after a failed call.
    const listed = (spec: ModelSpec) =>
      session.ask<{ verdicts?: unknown[] } | null>(spec, task, VERIFIER_SYSTEM, user, VERDICTS_SCHEMA, deadline).then((a) => {
        const list = a?.value?.verdicts;
        return Array.isArray(list) ? list : null;
      });
    const list = (await listed(DEEP)) ?? (await listed(WIDE));
    if (!list) return;
    b.judged = true;
    const verdicts = new Map<number, unknown>();
    for (const v of list) {
      const id = Number((v as { id?: unknown } | null)?.id);
      if (Number.isInteger(id)) verdicts.set(id, v);
    }
    for (const c of b.list) {
      const v = verdicts.get(c.id) as { keep?: unknown } | undefined;
      const f = v?.keep === true ? asFinding(v) : null;
      if (f) finals.push({ ...f, by: c.by, verified: true });
      // Only a verdict that says no rejects: a candidate the verifier passed over, judged without a yes or
      // a no, or kept without the fields a thread needs, stands unverified in its finder's words.
      else if (v?.keep === false) rejected++;
      else unverified.push(c);
    }
  };
  await session.run(batches.map(verify), t0 + limits.verify);
  for (const b of batches) if (!b.judged) unverified.push(...b.list);
  if (strays > 0) log(`  ${strays} candidate(s) sur un fichier hors du diff relu, écartée(s)`);

  // A review the relay stopped halfway (no credit, token refused) is not the pull request's review: what
  // it found is posted for information, without the mark the gate counts reviews by.
  const interrupted: LovableFailure | null = session.fatal ? (session.fatal.kind === 'credits' ? 'credits' : 'token') : null;
  if (interrupted && finals.length + unverified.length === 0) {
    return { kind: 'failed', failure: interrupted, threads: 0, line: `relecture Lovable interrompue (${interrupted}), rien de trouvé avant, ${session.tally.calls} appel(s), ${seconds(clock() - t0)}` };
  }

  // Anchoring: a line GitHub accepts, else the body. One thread per line, the most severe; minor ones in
  // the body. An important finding the verifier never judged still gets its thread, said unverified.
  const ann = new Map(g.reviewed.map((r) => [r.path, r.ann]));
  const placed = new Map<string, Thread>();
  const inBody: Final[] = [];
  const asFinal = ({ id: _, ...c }: Candidate): Final => ({ ...c, verified: false });
  const unverifiedHigh = unverified.filter((c) => c.severity === 'high').map(asFinal);
  for (const f of [...finals, ...unverifiedHigh].sort((a, b) => RANK[a.severity] - RANK[b.severity])) {
    const a = ann.get(f.path);
    const at = a ? anchor(f.line, a) : null;
    if (!a || at === null || f.severity === 'low') {
      inBody.push(f);
      continue;
    }
    const key = `${f.path}:${at}`;
    if (!placed.has(key)) placed.set(key, { ...f, line: at, onAdded: a.added.has(at) });
    else inBody.push(f);
  }
  const threads = [...placed.values()].sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.path.localeCompare(b.path) || a.line - b.line);
  inBody.push(...threads.splice(limits.threads));
  const notVerified = unverified.filter((c) => c.severity === 'medium').map(asFinal);
  const unread = [...new Set(chunks.flatMap((units, i) => (read.has(i) ? [] : units.map((u) => u.path))))];

  const tally = session.tally;
  const answered = [...tally.answered.entries()].map(([m, e]) => `${m} (${[...e].join(', ')})`).join(', ');
  const failures = Object.entries(tally.failures).map(([k, n]) => `${k} ${n}`).join(', ');
  const skipped = g.skipped.slice(0, 12).map((p) => `\`${p}\``).join(', ') + (g.skipped.length > 12 ? '…' : '');
  const body = (refused: Final[]) => {
    const offThread = [...refused, ...inBody];
    return [
      ...(interrupted
        ? [
            '### Relecture Lovable interrompue',
            `Copilot n’a pas relu cette PR (${input.why}), et le relais Lovable s’est arrêté en cours de relecture (${interrupted === 'credits' ? 'crédits Lovable épuisés' : 'jeton refusé'}) : voici ce qu’il avait trouvé, pour information. Cette relecture ne compte pas comme la revue de la PR.`,
          ]
        : [
            `${LOVABLE_MARK} head=${input.head} -->`,
            '### Relecture Lovable',
            `Copilot n’a pas relu cette PR (${input.why}) : la porte de fusion l’a fait relire par le relais Lovable, payé en crédits Lovable.`,
          ]),
      '',
      g.reviewed.length === 0
        ? `Rien à relire : ${g.skipped.length} fichier(s), aucun avec un diff écrit à la main (verrous, build, binaires, fichiers supprimés, ou diff trop gros pour que GitHub le montre).`
        : `**${threads.length - refused.length} remarque(s) en fil** sur \`${input.head.slice(0, 7)}\` · ${finals.length} retenue(s) et ${rejected} écartée(s) à la vérification, ${unverified.length} non vérifiée(s), sur ${candidates.length} candidate(s).`,
      ...(unread.length > 0
        ? [
            '',
            interrupted
              ? '#### Non relus (relais arrêté avant leur lecture)'
              : '#### Non relus (temps ou relais épuisé avant leur lecture ; la relecture compte quand même comme la revue de la PR)',
            ...fit(unread.map((p) => `- \`${p}\``), LIST_MAX),
          ]
        : []),
      ...(offThread.length > 0 ? ['', '#### Hors fil (mineures, sans ligne du diff, sur une ligne déjà commentée, au-delà du plafond de fils, ou refusées par GitHub)', ...fit(offThread.map(listItem), LIST_MAX)] : []),
      ...(notVerified.length > 0 ? ['', '#### Non vérifiées (temps ou relais épuisé avant la vérification, ou laissées sans verdict par le vérificateur)', ...fit(notVerified.map(listItem), LIST_MAX)] : []),
      '',
      '<details><summary>Comment cette relecture a été faite</summary>',
      '',
      `- ${g.reviewed.length} fichier(s) relu(s) en ${chunks.length} lot(s), avec leur contenu entier quand il tient dans un appel${g.skipped.length > 0 ? ` ; ${g.skipped.length} ignoré(s) : ${skipped}` : ''}.`,
      `- Recherche : chaque lot par ${DEEP.label} et ${WIDE.label}, puis ${SECOND.label} tant que le temps le permet, et une passe transversale sur le diff entier — ${searched} recherche(s) lancée(s) sur ${searches.length}.`,
      `- Vérification de chaque candidate contre le code par ${DEEP.label} (${WIDE.label} en secours).`,
      `- ${tally.ok} appel(s) réussi(s) sur ${tally.calls}${failures ? ` (échecs : ${failures})` : ''} · ${tally.prompt} jetons lus, ${tally.completion} écrits dont ${tally.reasoning} de raisonnement · ${seconds(clock() - t0)}.`,
      `- Modèles qui ont répondu : ${answered || 'aucun'}.`,
      '',
      '</details>',
    ].join('\n');
  };
  // Minutes went by: a review of a head the pull request has left would count for the new one.
  const now = await gh.rest<{ head?: { sha?: string } } | null>('GET', gh.repoPath(`/pulls/${input.number}`));
  if (now.status !== 200 || now.data?.head?.sha !== input.head) {
    log(`Lovable : la tête a bougé pendant la relecture (ou la PR est introuvable), rien n’est posté`);
    return { kind: 'moved' };
  }
  const posted = await post(gh, input.number, input.head, threads, body);
  const facts = `${posted} fil(s), ${finals.length}/${candidates.length} candidate(s) retenue(s)${unread.length > 0 ? `, ${unread.length} fichier(s) non relu(s)` : ''}, ${tally.ok}/${tally.calls} appels, ${tally.prompt} → ${tally.completion} jetons, ${seconds(clock() - t0)}`;
  if (interrupted) return { kind: 'failed', failure: interrupted, threads: posted, line: `relecture Lovable interrompue (${interrupted}), postée pour information : ${facts}` };
  return { kind: 'reviewed', threads: posted, line: `relue par Lovable : ${facts}` };
}
