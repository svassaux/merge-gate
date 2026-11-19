import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { anchor, annotate, numbered, pack, reviewable, weight, type Unit } from '../src/diff.ts';

/** A real patch of six hunks and the file at that head, recorded from GitHub (merge-gate #5). */
const recorded = JSON.parse(readFileSync(new URL('./fixtures/merge-gate-5-patch.json', import.meta.url), 'utf8')) as {
  files: { path: string; patch: string; content: string }[];
};
const real = recorded.files[0]!;

describe('the line numbers written into a diff', () => {
  it('cite, on GitHub’s real patch, the very line the head file holds there', () => {
    // The contract a review comment rests on: GitHub places a comment on the head file's line, so a
    // number off by one puts every thread on the wrong line. Judged against the file GitHub serves.
    const a = annotate(real.patch);
    const head = real.content.split('\n');
    const cited = [...a.text.matchAll(/^ *(\d+) ([+ ]) (.*)$/gm)];
    const kept = real.patch.split('\n').filter((l) => l[0] === '+' || l[0] === ' ').length;
    assert.equal(cited.length, kept, 'every added and context line is numbered');
    for (const [, n, , code] of cited) assert.equal(code, head[Number(n) - 1], `line ${n}`);
    assert.equal(a.commentable.size, kept);
    assert.equal(a.added.size, real.patch.split('\n').filter((l) => l[0] === '+').length);
    // Removed lines are shown, unnumbered, and take no number from the lines after them.
    assert.ok(a.text.split('\n').some((l) => /^ {7}- /.test(l)));
  });

  it('skip the no-newline marker instead of counting it as a line', () => {
    const a = annotate('@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file');
    assert.deepEqual([...a.commentable], [1, 2]);
    assert.deepEqual([...a.added], [2]);
  });

  it('number a file’s content the same way', () => {
    assert.equal(numbered('a\nb\n'), '     1| a\n     2| b');
  });
});

describe('what the review reads', () => {
  it('a text diff a person wrote, still present at the head — not lock files, build output, snapshots or binaries', () => {
    const patch = '@@ -1 +1 @@\n-a\n+b';
    for (const [path, status, expected] of [
      ['src/gate.ts', 'modified', true],
      ['apps/web/src/page.tsx', 'added', true],
      ['docs/build.md', 'modified', true],
      // A build folder holds hand-written scripts as often as output: read.
      ['build/deploy.sh', 'modified', true],
      ['packages/web/dist/index.js', 'modified', false],
      ['apps/api/vendor/lib.php', 'added', false],
      ['pnpm-lock.yaml', 'modified', false],
      ['apps/api/package-lock.json', 'modified', false],
      ['dist/index.js', 'modified', false],
      ['web/.next/server.js', 'added', false],
      ['src/__snapshots__/x.test.ts.snap', 'modified', false],
      ['public/logo.svg', 'added', false],
      ['src/old.ts', 'removed', false],
    ] as [string, string, boolean][]) {
      assert.equal(reviewable({ path, status, patch }), expected, path);
    }
    assert.equal(reviewable({ path: 'src/big.ts', status: 'modified', patch: null }), false, 'no patch: binary, or too large for GitHub to show');
  });
});

describe('packing files into calls', () => {
  const unit = (path: string, diffChars: number, contentChars: number | null): Unit => ({
    path,
    diff: `@@ -1 +1 @@\n${'x'.repeat(diffChars)}`,
    content: contentChars === null ? null : 'c'.repeat(contentChars),
  });

  it('keeps every call under its budget, files in path order, a file whole when it fits', () => {
    const chunks = pack([unit('b.ts', 300, 2_000), unit('a.ts', 300, 2_000), unit('c.ts', 300, 2_000)], 5_000);
    assert.deepEqual(chunks.map((c) => c.map((u) => u.path)), [['a.ts', 'b.ts'], ['c.ts']]);
    for (const c of chunks) assert.ok(c.reduce((n, u) => n + weight(u), 0) <= 5_000);
    assert.ok(chunks.flat().every((u) => u.content !== null && u.part === undefined));
  });

  it('drops a file’s content before cutting its diff, and cuts the diff at its hunks without losing one', () => {
    const [withoutContent] = pack([unit('a.ts', 1_000, 9_000)], 5_000);
    assert.equal(withoutContent?.[0]?.content, null);
    const hunks = Array.from({ length: 6 }, (_, i) => `@@ -${i * 10 + 1},2 +${i * 10 + 1},2 @@\n${'y'.repeat(1_500)}`);
    const parts = pack([{ path: 'big.ts', diff: hunks.join('\n'), content: null }], 5_000).flat();
    assert.ok(parts.length > 1);
    assert.deepEqual(parts.map((u) => u.part), parts.map((_, i) => `${i + 1}/${parts.length}`));
    assert.equal(parts.map((u) => u.diff).join('\n'), hunks.join('\n'));
    for (const u of parts) assert.ok(weight(u) <= 5_000);
  });

  it('splits a hunk too long for one call at its lines, so the end of a long new file still reaches a call', () => {
    const added = Array.from({ length: 2_000 }, (_, i) => `+const v${i} = ${i};`);
    const diff = annotate(`@@ -0,0 +1,2000 @@\n${added.join('\n')}`).text;
    const parts = pack([{ path: 'new.ts', diff, content: null }], 5_000).flat();
    assert.ok(parts.length > 1);
    for (const u of parts) assert.ok(weight(u) <= 5_000);
    const shown = parts.flatMap((u) => [...u.diff.matchAll(/^ *(\d+) \+ /gm)].map((m) => Number(m[1])));
    assert.deepEqual(shown, Array.from({ length: 2_000 }, (_, i) => i + 1));
  });
});

describe('the line a comment goes on', () => {
  const a = { commentable: new Set([10, 11, 12, 20]), added: new Set([11]) };

  it('the line cited when GitHub accepts a comment there', () => assert.equal(anchor(12, a), 12));
  it('else the nearest added line within reach, before a nearer context line', () => assert.equal(anchor(14, a), 11));
  it('else the nearest context line within reach', () => assert.equal(anchor(22, a), 20));
  it('else none: the finding goes into the review’s body', () => assert.equal(anchor(40, a), null));
});
