# merge-gate

A GitHub Action that keeps a finalized pull request **in draft** until three things hold on its head:
the CI is green, Copilot has reviewed it, and no review thread is open. Then it marks the pull request
ready, which unlocks the Merge button. When Copilot is out of credits, or does not answer, the gate
has the Lovable relay review the pull request in its place, on Lovable credits, where the repository
hands it the relay's secrets ([The Lovable review](#the-lovable-review)); without them, or when the
relay fails too, it opens the pull request without the review and says so: it never blocks on Copilot.

The same code serves every repository: the `svassaux` repositories call this public repository at
`@v1`, and the FoodMeUp ones are to do the same, melba first (FoodMeUp/melba#150). A private
repository cannot call a workflow of another owner's private repository, hence public since
2026-10-07; the history holds no credential.

## The contract

1. **Work draft.** The gate does not touch a draft that was never handed to it.
2. **Hand-over.** Marking the pull request ready hands it to the gate. The gate then:
   - puts the `merge-gate` label on, meaning "finalized, kept by the gate";
   - draws the pull request back to draft until everything is green. On a repository without
     branch protection, the draft is what keeps the Merge button disabled.
3. **Copilot reviews a pull request once.** The gate asks while the pull request has no Copilot review;
   a request that yielded none (credits exhausted, request ignored) is tried again on the next head.
   Every push after the review, those answering its threads included, costs none. The gate never asks:
   - while Copilot is already queued (a second request would strand in the queue);
   - while a thread is open;
   - while the CI is red;
   - on a work draft.

   Each request names its effort, `copilot-effort`, `lite` by default: GitHub's averages are $0.25 a
   review with Lite and $1.50 with Balanced, and a request that names none pays the account's default,
   Balanced since 2026-09-28. From 1 to 19 November 2026, 69 of the 73 reviews on the gated
   repositories ran at Balanced, and the account's credits came to about 260 a review.

   With `first-review: ruleset`, a repository ruleset asks for that review, at the effort the
   repository's settings name. The gate gives it 5 minutes, then asks itself.

   Where the relay's secrets are set, the relay's review stands for Copilot's, and a later head asks
   for neither. A Copilot review still queued past its timeout may yet land beside the relay's.

   GitHub may also ask before the gate does. When the account's automatic review is on (Copilot
   settings → Code review), GitHub requests a review when a pull request leaves draft, at the
   account's effort. The gate then finds Copilot queued, waits for that review and asks nothing. Only
   that setting decides what this review costs. On #6, on 2026-11-19, the request came 2 s after the
   hand-over and the review said "Review effort: Balanced".
4. **Opening.** When the CI is green, no thread is open and the review is in, the gate:
   - marks the pull request ready;
   - takes the label off;
   - publishes `merge-gate` as success.
5. **Copilot unavailable never blocks.**
   - The gate reads the quota before asking, and asks nothing once the credits are gone. Gone means
     both allowances: past the included entitlement `remaining` goes negative, but where overage is
     permitted GitHub bills against a second allowance and Copilot is expected to keep answering — so
     the gate keeps asking until that one is spent too. What was read on 2026-10-03:
     `overage_count: 421` of an `overage_entitlement` of 4000, while `remaining` was −422. That a
     review the gate asks for is then billed to that counter is the expectation, not a measurement.
     An answer that permits an overage without sizing it counts as room, because an unknown quota
     never stops a request: if
     Copilot has nothing left, the request is dropped instead, which the next point covers.
   - A request GitHub refuses (a client error: no credits, ineligible repository or account) yields no
     review; an outage fails the run, and the next one asks again. A request it accepts, or one
     already pending, must show up in Copilot's queue within 20 s, or it was dropped.
   - A review still queued after 20 minutes will not come.

   In all three cases the pull request opens without the review. One comment on the pull request
   records which head went unreviewed and why. The success status says "NON relue par Copilot".
   - **Where the relay's secrets are set**, none of these opens the pull request: the relay reviews
     it — in that run, or in a later one when the run had it review another pull request already —
     and the gate opens it on that review's verdict. The quota then counts as gone
     as soon as the included entitlement is: the relay's credits are already paid for, Copilot's
     overage is billed. Only when the relay fails too (no Lovable credit, token refused, no answer,
     a review GitHub refuses), or stops halfway, does the pull request open unreviewed, and the comment
     and the status name both reasons.
6. **One status, `merge-gate`**, on the head:
   - `success`: the pull request may be merged;
   - `pending`: the gate waits on the CI or on Copilot, or the relay is reviewing ("Lovable relit");
   - `failure`: the author must act, because the CI is red or a thread is open.
7. **Taking the label off** hands the pull request back to its author.

## Wake-ups

A run reads the pull request once, decides, acts, and ends. It never waits, apart from the 20 s
spent confirming that a request reached Copilot's queue, and the minutes of a Lovable review. It adds no time to the CI either: it runs
beside it, never inside it, and asks Copilot while the CI is still running. Something must therefore
wake the gate each time the state changes:

| Change | Wakes the gate |
| --- | --- |
| push, hand-over, reopening | `pull_request_target` (here `pull_request`): it runs on the default branch, so the pull request shows only the gate's verdict |
| a CI workflow finished | `workflow_run` of the CI workflows |
| Copilot submitted its review, or never answers | the `*/5` sweep, which runs only while a `MERGE_GATE_AWAIT_<n>` repository variable exists; a watcher that sees the review can wake the gate at once with `gh workflow run merge-gate.yml -f pr=<n>` |
| a deployment's commit status settled | the same sweep |
| a thread resolved without a push | **nothing**: GitHub has no workflow event for it. Run `gh workflow run merge-gate.yml -f pr=<n>`, or click *Ready for review* |

Nothing Copilot does wakes the gate. A run started by its `pull_request_review` event, or by the
`workflow_run` of its dynamic `Copilot` workflow, waits for an approval and never executes
(`action_required`, measured 2026-10-02). The gate therefore keeps one repository variable per pull
request that waits on Copilot or on a deployment's status, and the sweep reads only those.

GitHub fires a `*/5` schedule late: every 10 to 25 minutes in practice. On #1 the gate opened the
pull request 13.6 minutes after Copilot's review. Where an agent watches the pull request, it wakes the
gate the moment the review lands; the sweep is the fallback when nobody watches.

## The Lovable review

When Copilot cannot review a head and the CI is not red and no thread is open, the gate holds the pull
request ("Lovable relit"), has the relay review it, posts the review, and decides again on what it
left. Each step spends as much as a relay call allows, many times over:

- **Reading.** Every changed file a person wrote, with its whole content at the head when it fits;
  deleted files, lock files, build output (`dist/`, `vendor/`, `node_modules/`… at any depth; not
  `build/`, as often hand-written), snapshots, binaries and diffs GitHub does not show are named to
  the models but not shown. The files are packed, in path order, into chunks of about 36,000
  characters, one call each; a diff too long for one is split at its hunks, and a hunk at its lines. The diff carries
  the new file's line numbers, so a model cites the line a comment goes on instead of counting. The
  repository's `.github/copilot-instructions.md`, `AGENTS.md` and `CLAUDE.md` go with every call.
- **Search.** Each chunk is read by two model families, GPT-6.1 terra at high effort and Gemini 4
  argon at medium, then by GPT-6.1 sol while time remains; the whole diff once more for what only
  shows across files (claims of the description, a change made on one path and not its twin). The
  checklist is the workspace's `pr-reviewer` one, calibrated on 622 Copilot threads.
- **Verification.** Every candidate is checked against the code of its chunk by GPT-6.1 terra
  (Gemini in its place when it fails), which keeps it, rejects it or merges duplicates, and writes the
  final comment. Only a verdict that says no rejects: an important candidate left unjudged — time ran
  out, the relay failed, or the verifier passed over it or answered neither yes nor no — still gets its
  thread, said unverified; a medium one is listed in the body. A verification answered off its format
  goes to the other family, as a failed call does.
- **Posting.** One `COMMENT` review: a thread per kept finding on the line it cites, or the nearest
  line of the diff; minor findings, findings without a line, a second finding on a line and those
  past 25 threads go into its body, as do the files no model could read in time (the review still
  counts as the pull request's). A review GitHub
  refuses (422) is posted again with its context-line threads, then all of them, moved into the
  body; the body's lists are cut to stay under GitHub's size limit. The review starts with
  `<!-- merge-gate:lovable-review head=… -->`, which is how the next run knows the pull request was
  reviewed — a review by the gate token's owner only, as anyone can post one on a public repository.
  A run that only watches another run's review never writes over its status, even when it fails: that
  status is the review's lock.
  Nothing is posted when the head moved during the review: the run of the new head reviews that one.

The relay is Lovable's hosting behind Cloudflare: a call it has not answered in about 126 s never
will (524). Hence many bounded calls, each one effort lower after a timeout, at most three at once;
no search call starts after 6 minutes, no verification call after 12, and the job's timeout is 20
minutes, so a run has the relay review one pull request at most; another one waits, held, for a
later run ("relecture Lovable à venir"). Other runs know a review is in flight by the "Lovable relit"
status the reviewing run writes before starting, younger than that timeout, and leave it as it is. In
the usual case only: GitHub offers no atomic lock, so two runs that read the pull request in the same
seconds may both start one. GitHub out, out of reach or throttling fails the run, and a later run
reviews again; a review or a file list GitHub refuses, or lists in part (it stops at 3,000 files),
counts as the relay's failure. On the relay's side, a call that fails costs that call alone: the
review goes on with the others and names the files none could read, a search answered off its format
counts as failed, and a relay that answers no search at all is its failure — never a hold, as
a Lovable outage must not block merges. A 402 (no Lovable credit) or a refused token stops the
review at once: what it had found is posted for information, without the mark, and the pull request
opens unreviewed as above.

Measured on 2026-11-19, dry runs on pull requests Copilot had reviewed:

| Pull request | Files | Calls | Tokens read → written | Time | Threads | Copilot's threads found |
| --- | --- | --- | --- | --- | --- | --- |
| merge-gate #5 | 6 (+1 build) | 15, no failure | 156 k → 24 k | 221 s | 4 | 1 of 2; on the other's lines, a neighbouring defect |
| filterwise #167 | 17 | 29, no failure | 382 k → 30 k | 263 s | 8 | 3 of 4 (missed: a migration an older one breaks, outside the diff) |
| merge-gate #5, again, with the build named to the models | 6 (+1 build) | 18, one timeout | 179 k → 31 k | 312 s | 5 | the first run's false "the build is not updated" gone |

`scripts/lovable-review.ts` runs the review of any pull request by hand and prints the review instead
of posting it.

**Never on a repository that holds customers' data**: the relay sends the diff and the files to
Lovable's AI gateway. Code alone may go — Melba's included, since 2026-11-19.

## Install

1. Copy [`templates/merge-gate.yml`](templates/merge-gate.yml) to `.github/workflows/merge-gate.yml`.
   Adapt its one `# ADAPT` line, the names of the CI workflows; pass `required-checks` only when the CI's
   aggregate job is not named `verify`. The caller holds nothing but its triggers, which GitHub requires
   there: the job itself is [`.github/workflows/gate.yml`](.github/workflows/gate.yml), called at `@v1`,
   so a change to its conditions, concurrency or defaults reaches every repository without a pull request.
2. Set the `GATE_TOKEN` repository secret to a token of the repository owner. A classic PAT with
   `repo` and `workflow` scopes is enough. It must be able to read `copilot_internal/user`, so it is
   the token of the account whose Copilot credits pay for the reviews. The caller hands the gate this
   secret, and the relay's two of step 4 where they are set, by name — never `secrets: inherit`: on
   `pull_request_target` it runs with the default branch's privileges, and a mutable `@v1` reference
   must not receive the repository's other secrets.
3. The `merge-gate` label is created the first time the gate uses it.
4. Optionally, for [the Lovable review](#the-lovable-review): set `LOVABLE_RELAY_URL` (the relay's
   address, a secret because a public repository's run logs are public) and `LOVABLE_RELAY_TOKEN` (a
   relay token for this caller; its calls are logged as `merge-gate:<repository>`). Both or neither.

The gate's own minutes (a run is billed one minute on a private repository; one that has the relay
review a pull request, up to twenty) stay at a handful per pull request. The gate skips these runs before a runner starts:
- pushes to a work draft;
- CI runs on `main`;
- cancelled CI runs;
- the sweep, when nothing waits.

## Development

```sh
pnpm install
pnpm check        # typecheck, tests, build, and dist/ must be the build of src/
```

- `src/verdict.ts` is the whole decision. It is pure, and `test/verdict.test.ts` covers it as a table.
- `src/snapshot.ts` reads a pull request in one GraphQL query. `test/fixtures/*.json` are real answers
  to that query, recorded with `scripts/record-fixture.ts`.
- `src/gate.ts` acts, in an order that leaves a recognizable state if a run dies halfway.
- `src/review.ts` is the Lovable review: `src/diff.ts` shapes what it reads, `src/prompts.ts` what it
  asks, `src/relay.ts` calls the relay. `test/review.test.ts` runs it on a real patch with a fake
  relay; `test/relay.test.ts` parses the relay's real answers.
- This repository gates its own pull requests through the same shared job, with the checked-out action
  (`.github/workflows/merge-gate.yml` calls `gate.yml` with `local: true`). A change is proven on a real
  pull request, or a dispatch, before it is tagged.
- `test/workflows.test.ts` keeps the callers thin: the template and this repository's caller share their
  triggers, and the shared job forwards every input of the action.

## Release

`dist/` is committed; CI fails when it is not the build of `src/`.

```sh
pnpm check
git tag v1.x.y && git push origin v1.x.y
gh api -X PATCH repos/svassaux/merge-gate/git/refs/tags/v1 --raw-field sha="$(git rev-parse HEAD)" --field force=true
```
