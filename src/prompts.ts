/**
 * What the Lovable review asks its models. The checklist is the one the workspace's `pr-reviewer`
 * agent was calibrated with on 622 real Copilot threads (2026-10-01), ordered by what Copilot found
 * most on these repositories, with the three defect families that cover nearly all of them.
 */

export type Severity = 'high' | 'medium' | 'low';

export const FINDING_PROPERTIES = {
  path: { type: 'string', description: 'The file, exactly as its header names it.' },
  line: { type: 'integer', description: 'The new-file line number printed left of a + or context line of that file’s diff.' },
  severity: { type: 'string', enum: ['high', 'medium', 'low'] },
  category: { type: 'string', description: 'A few words: the checklist item it falls under.' },
  title: { type: 'string', description: 'The defect in one sentence, at most 100 characters.' },
  explanation: { type: 'string', description: 'The concrete failure: which input or state, what goes wrong, why — 2 to 5 sentences.' },
  fix: { type: 'string', description: 'The fix, in one or two sentences or a short code excerpt; empty when obvious.' },
} as const;

export const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: { type: 'object', properties: FINDING_PROPERTIES, required: Object.keys(FINDING_PROPERTIES) },
    },
  },
  required: ['findings'],
} as const;

export const VERDICTS_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'The candidate’s id.' },
          keep: { type: 'boolean' },
          reason: { type: 'string', description: 'Why it is kept or rejected, citing the code — one or two sentences.' },
          ...FINDING_PROPERTIES,
        },
        required: ['id', 'keep', 'reason', ...Object.keys(FINDING_PROPERTIES)],
      },
    },
  },
  required: ['verdicts'],
} as const;

const CHECKLIST = `Checklist — ordered by what reviewers find most on these repositories. Walk every file against all of it.
1. Stale prose: every changed comment, docstring, README or doc line, log or error message, and every claim of the pull request description — does the code now do exactly that? Check every verb of a touched doc comment against the code.
2. Swallowed errors: every catch / except / .catch() / "|| true" — does it rethrow or report, or does it return normally and break the caller's retry, close or rollback contract? A catch that turns a TypeError into "empty data" hides a bug.
3. User-facing text and locales: untranslated or wrong-language strings, a hard-coded string where i18n is claimed, locale-specific regexes or word lists.
4. CI and configuration: a changed workflow, deployment config, path filter or exemption list — is the new file exercised by the job it should trigger? Does a job bypass the gate? Is a token scoped to the step that needs it?
5. Tests that cannot fail: for each new assertion, what real input turns it red? A fixture that closes the very window the test claims to judge, a vacuous every()/some() on an empty array, an assertion that holds whatever the code does.
6. Migrations and SQL: explicit casts, NOT NULL on existing rows, a reversible down(), backfills that rerun on each deploy, a migration outside the directory the config scans.
7. Concurrency on a second path: for any shared or claimed state (a row's status, an in-flight set, a lock, a ref, a transaction), every acquire and release site — release on the error path, deletion between claim and use, a second caller.
8. Contract drift: a changed signature, return type, payload or interface — does every call site and declared type still match?
9. Edge cases of each new condition: null, undefined, empty, zero, false and '' (x || fallback when x may be 0), sign, off-by-one, time zones and month rollover, state not reset on an early return, filters that silently drop rows.
10. Security: secrets or tokens reaching logs, URLs or files; trusted proxy headers; cache keys without user scoping; injection.
11. Accessibility of new UI: accessible names, alt text, keyboard focus, aria-pressed on toggles.
12. Lifecycle: effect dependency lists, cleanup on unmount, a subscription or timer never released, the error path.
13. Performance: unbounded arrays or caches, N+1 queries in a loop, work repeated per call that could be done once.
14. Business logic: trace each new branch by hand with one concrete input against what the pull request says it does — the largest single source of real defects.`;

const RULES = `Rules:
- Report real defects only: what would break, mislead, or fail in production, in CI or for the next reader. No style, formatting, naming or import-order remarks, no praise, no summary, no "consider adding logging", no speculation without a failure you can describe.
- Every finding names a concrete failure: this input or this state → this wrong result.
- Read the whole file content given before reporting: never flag what the code already handles elsewhere.
- Anchor each finding on a line of the diff: the number printed left of a "+" or context line of that file. Prefer the added line that causes the defect.
- severity: high = wrong behaviour, data loss, a security hole, a broken build or deployment; medium = a real bug on an edge case, a test that cannot fail, prose the code contradicts; low = minor but real.
- At most 15 findings, the most serious first. An empty list is a valid answer: do not invent findings to have some.
- Write title, explanation and fix in the language of the pull request's title and description.`;

export interface PullRequestText {
  repository: string;
  title: string;
  description: string;
  /** Repository instructions for reviewers and agents (copilot-instructions, AGENTS.md, CLAUDE.md), possibly cut. */
  guidance: string;
  /** Files the pull request changes that no call shows — removed, machine-written, binary, or a diff GitHub does not show — each with its status. */
  unshown: string[];
}

function header(pr: PullRequestText): string {
  return [
    `Repository: ${pr.repository}`,
    `Pull request title: ${pr.title}`,
    `Pull request description:\n${pr.description.trim() || '(none)'}`,
    // Without it a model reads a source change whose build output it never sees, and reports that build as not updated.
    pr.unshown.length > 0
      ? `Also changed by the pull request, not shown here (removed, machine-written — lock files, build output —, binary, or a diff too large for GitHub to show; the pull request does change them, and a removal can be a finding of its own): ${pr.unshown.join(', ')}`
      : '',
    pr.guidance ? `Repository guidelines (the project's own rules — a change that breaks one is a finding):\n${pr.guidance}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export const FINDER_SYSTEM = `You are a senior software engineer doing the one review this pull request gets before it is merged, in place of GitHub Copilot code review. Your findings become review threads the author must answer, so each must be worth a thread. Think hard: trace the code, follow each changed value to where it is used, and check the claims against the code.

${CHECKLIST}

${RULES}`;

export interface ChunkText {
  /** Which part of the pull request this call holds, e.g. "part 2 of 3". */
  part: string;
  /** Every changed file of the pull request, so a call knows what lies outside its part. */
  allFiles: string[];
  files: { path: string; diff: string; content: string | null; part?: string }[];
}

export function finderPrompt(pr: PullRequestText, chunk: ChunkText): string {
  const files = chunk.files.map((f) =>
    [
      `===== FILE ${f.path}${f.part ? ` (diff part ${f.part})` : ''} =====`,
      `--- diff (new-file line numbers on the left; "+" added, "-" removed, blank context) ---`,
      f.diff,
      f.content === null ? '--- full content: not included (too large) ---' : `--- full content at the head ---\n${f.content}`,
    ].join('\n'),
  );
  return [
    header(pr),
    `Files changed by the pull request (${chunk.allFiles.length}): ${chunk.allFiles.join(', ')}`,
    `This call holds ${chunk.part}. Review these files:`,
    ...files,
  ].join('\n\n');
}

export const CROSS_SYSTEM = `You are a senior software engineer reviewing a whole pull request for the defects that only show across files. Other reviewers read each file in depth; you look at the change as a whole. Think hard.

Look for:
- every claim of the title and description ("removed", "replaced", "all … now", "no more …", "fixes …") that the diff does not carry out, or contradicts;
- a change applied on one path but not on its twin (a second caller, a second implementation, the other platform, the other locale);
- a signature, payload, setting or name changed in one file while another changed file still uses the old one;
- documentation, comments or configuration in one file that another file's change makes false;
- new behaviour with no test, or a test changed so that it no longer judges what it claims;
- behaviour the diff changes that the description does not mention.

${RULES}`;

export function crossPrompt(pr: PullRequestText, diffs: { path: string; diff: string }[], cut: boolean): string {
  return [
    header(pr),
    `The whole diff (${diffs.length} files${cut ? ', each cut to fit one call' : ''}; new-file line numbers on the left):`,
    ...diffs.map((d) => `===== FILE ${d.path} =====\n${d.diff}`),
  ].join('\n\n');
}

export const VERIFIER_SYSTEM = `You verify candidate review findings that other reviewers proposed on a pull request. Only what you keep is posted, as review threads the author must answer: a false positive wastes their time, a missed real defect ships. Think hard and check each candidate against the code itself.

For each candidate:
- keep it only if the defect is real, caused or touched by this pull request, and worth a thread: trace the code to confirm the failure it describes;
- reject it when the code already handles the case (say where), when it is speculative, a matter of style or taste, outside the change, or a duplicate of another candidate (keep the clearest one, reject the others as "duplicate of #id");
- when you keep it, return the final comment: correct the path and the line to the exact diff line the defect sits on (a number printed left of a "+" or context line), set the severity honestly, and rewrite title, explanation and fix so they are precise, short and checkable — in the language of the pull request's title and description.

Return one verdict for every candidate id.`;

export interface CandidateText {
  id: number;
  path: string;
  line: number;
  severity: Severity;
  category: string;
  title: string;
  explanation: string;
  fix: string;
}

export function verifierPrompt(pr: PullRequestText, chunk: ChunkText, candidates: CandidateText[]): string {
  return [
    finderPrompt(pr, chunk),
    `===== CANDIDATE FINDINGS (${candidates.length}) =====`,
    JSON.stringify(candidates, null, 1),
  ].join('\n\n');
}
