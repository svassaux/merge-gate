# merge-gate

A GitHub Action that keeps a finalized pull request **in draft** until three things hold on its head:
the CI is green, Copilot has reviewed it, and no review thread is open. Then it marks the pull request
ready, which unlocks the Merge button. When Copilot is out of credits, or does not answer, the gate
opens the pull request without the review and says so: it never blocks on Copilot.

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

   With `first-review: ruleset`, a repository ruleset asks for that review. The gate gives it
   5 minutes, then asks itself.
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
   - A request that does not reach Copilot's queue within 20 s was dropped. Copilot without credits
     drops a request silently.
   - A review still queued after 20 minutes will not come.

   In all three cases the pull request opens without the review. One comment on the pull request
   records which head went unreviewed and why. The success status says "NON relue par Copilot".
6. **One status, `merge-gate`**, on the head:
   - `success`: the pull request may be merged;
   - `pending`: the gate waits on the CI or on Copilot;
   - `failure`: the author must act, because the CI is red or a thread is open.
7. **Taking the label off** hands the pull request back to its author.

## Wake-ups

A run reads the pull request once, decides, acts, and ends. It never waits, apart from the 20 s
spent confirming that a request reached Copilot's queue. It adds no time to the CI either: it runs
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

## Install

1. Copy [`templates/merge-gate.yml`](templates/merge-gate.yml) to `.github/workflows/merge-gate.yml`.
   Adapt its one `# ADAPT` line, the names of the CI workflows; pass `required-checks` only when the CI's
   aggregate job is not named `verify`. The caller holds nothing but its triggers, which GitHub requires
   there: the job itself is [`.github/workflows/gate.yml`](.github/workflows/gate.yml), called at `@v1`,
   so a change to its conditions, concurrency or defaults reaches every repository without a pull request.
2. Set the `GATE_TOKEN` repository secret to a token of the repository owner. A classic PAT with
   `repo` and `workflow` scopes is enough. It must be able to read `copilot_internal/user`, so it is
   the token of the account whose Copilot credits pay for the reviews. The caller hands the gate this
   secret alone, never `secrets: inherit`: on `pull_request_target` it runs with the default branch's
   privileges, and a mutable `@v1` reference must not receive the repository's other secrets.
3. The `merge-gate` label is created the first time the gate uses it.

The gate's own minutes (each run is billed one minute on a private repository) stay at a handful per
pull request. The gate skips these runs before a runner starts:
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
