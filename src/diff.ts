/**
 * What the Lovable review reads of a pull request, cut to the size of one relay call. Pure: the
 * review engine (review.ts) fetches, this file shapes.
 */

/** One changed file, as `GET /pulls/{n}/files` lists it. */
export interface FileDiff {
  path: string;
  /** `added`, `modified`, `renamed`, `removed`, `copied`, `changed`, `unchanged`. */
  status: string;
  /** Absent for a binary file, and for a diff GitHub deems too large to show. */
  patch: string | null;
}

/** Lock files and build output: machine-written, and what a reviewer skips too. */
const LOCK_FILES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lockb',
  'composer.lock',
  'Cargo.lock',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock',
  'Gemfile.lock',
  'go.sum',
]);
/**
 * Build output and installed dependencies at any depth (a package of a monorepo included), and test
 * snapshots. Not `build/`: as often a folder of hand-written scripts and configuration as one of output.
 */
const GENERATED_DIR = /(?:^|\/)(?:dist|vendor|node_modules|\.next|coverage|__snapshots__)\//;
const GENERATED_EXT = /\.(?:min\.js|min\.css|map|snap|svg|png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|otf|eot|mp3|mp4|zip|gz)$/i;

/** Whether the review reads this file: a text diff a person wrote, still present at the head. */
export function reviewable(f: FileDiff): boolean {
  if (!f.patch || f.status === 'removed') return false;
  const name = f.path.slice(f.path.lastIndexOf('/') + 1);
  return !LOCK_FILES.has(name) && !GENERATED_DIR.test(f.path) && !GENERATED_EXT.test(f.path);
}

export interface Annotated {
  /** The hunks, each kept line prefixed by its line number in the new file. */
  text: string;
  /** New-file lines GitHub accepts a review comment on (`side: RIGHT`): the hunks' added and context lines. */
  commentable: Set<number>;
  /** The added lines alone. */
  added: Set<number>;
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * A unified patch with the new file's line numbers written in, so a model cites the line a comment
 * goes on instead of counting: `    12 + added`, `    13   context`, `       - removed`.
 */
export function annotate(patch: string): Annotated {
  const out: string[] = [];
  const commentable = new Set<number>();
  const added = new Set<number>();
  let next = 0;
  for (const line of patch.split('\n')) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      next = Number(hunk[1]);
      out.push(line);
      continue;
    }
    // `\ No newline at end of file`, and the empty string a trailing newline leaves.
    if (line === '' || line.startsWith('\\')) continue;
    const code = line.slice(1);
    if (line[0] === '-') {
      out.push(`${' '.repeat(6)} - ${code}`);
      continue;
    }
    commentable.add(next);
    if (line[0] === '+') added.add(next);
    out.push(`${String(next).padStart(6)} ${line[0] === '+' ? '+' : ' '} ${code}`);
    next++;
  }
  return { text: out.join('\n'), commentable, added };
}

/** A file's content with its line numbers, the way the annotated diff cites them. */
export function numbered(content: string): string {
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((line, i) => `${String(i + 1).padStart(6)}| ${line}`).join('\n');
}

/** One file as a review call sees it: its annotated diff, and its whole content when it fits. */
export interface Unit {
  path: string;
  diff: string;
  /** Numbered content at the head, or null when it did not fit or could not be read. */
  content: string | null;
  /** Set when the diff was cut: which part of the file's diff this unit holds. */
  part?: string;
}

/** What a unit weighs in a call, in characters. */
export const weight = (u: Unit) => u.path.length + u.diff.length + (u.content?.length ?? 0) + 64;

const CONTINUED = '[… the hunk goes on from the previous part]';

/**
 * A hunk over `budget` characters, split at its lines into pieces that fit: every line keeps its
 * number, so nothing of a long new file is lost. Only a single line longer than a call is cut.
 */
function splitHunk(hunk: string, budget: number): string[] {
  if (hunk.length <= budget) return [hunk];
  const room = budget - CONTINUED.length - 1;
  const parts: string[] = [];
  let current = '';
  for (const raw of hunk.split('\n')) {
    const line = raw.length > room ? `${raw.slice(0, room - 20)} [… line cut]` : raw;
    if (current && current.length + line.length + 1 > budget) {
      parts.push(current);
      current = CONTINUED;
    }
    current = current ? `${current}\n${line}` : line;
  }
  if (current) parts.push(current);
  return parts;
}

/** Split an annotated diff at its hunks into pieces of at most `budget` characters; a hunk alone over it at its lines. */
function splitDiff(diff: string, budget: number): string[] {
  const hunks: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@') || hunks.length === 0) hunks.push(line);
    else hunks[hunks.length - 1] += `\n${line}`;
  }
  const pieces: string[] = [];
  let current = '';
  for (const h of hunks.flatMap((hunk) => splitHunk(hunk, budget))) {
    if (current && current.length + h.length + 1 > budget) {
      pieces.push(current);
      current = '';
    }
    current = current ? `${current}\n${h}` : h;
  }
  if (current) pieces.push(current);
  return pieces;
}

/**
 * Pack the files into chunks of at most `budget` characters, one relay call each, in path order so a
 * chunk keeps neighbouring files together. A file too large with its content goes without it; a diff
 * too large on its own is split at its hunks, and a hunk too large at its lines, into several units of
 * the same file.
 */
export function pack(units: readonly Unit[], budget: number): Unit[][] {
  const fitted: Unit[] = [];
  for (const u of [...units].sort((a, b) => a.path.localeCompare(b.path))) {
    if (weight(u) <= budget) fitted.push(u);
    else if (weight({ ...u, content: null }) <= budget) fitted.push({ ...u, content: null });
    else {
      const pieces = splitDiff(u.diff, budget - u.path.length - 128);
      pieces.forEach((diff, i) => fitted.push({ path: u.path, diff, content: null, part: `${i + 1}/${pieces.length}` }));
    }
  }
  const chunks: Unit[][] = [];
  let current: Unit[] = [];
  let used = 0;
  for (const u of fitted) {
    if (current.length > 0 && used + weight(u) > budget) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(u);
    used += weight(u);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * The line a comment goes on: `line` itself when GitHub accepts a comment there, else the nearest
 * added line within `reach`, else the nearest context line within it; null when none.
 */
export function anchor(line: number, a: Pick<Annotated, 'commentable' | 'added'>, reach = 3): number | null {
  if (a.commentable.has(line)) return line;
  for (const lines of [a.added, a.commentable]) {
    for (let d = 1; d <= reach; d++) {
      if (lines.has(line - d)) return line - d;
      if (lines.has(line + d)) return line + d;
    }
  }
  return null;
}
