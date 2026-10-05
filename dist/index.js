// src/main.ts
import { readFileSync } from "node:fs";

// src/github.ts
var ATTEMPTS = 3;
var TIMEOUT_MS = 15e3;
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var TOLERATED = /* @__PURE__ */ new Set([404, 409, 422]);
var GitHub = class {
  owner;
  repo;
  #token;
  #api;
  constructor(token, owner, repo, api = "https://api.github.com") {
    this.#token = token;
    this.owner = owner;
    this.repo = repo;
    this.#api = api.replace(/\/$/, "");
  }
  /** `/repos/{owner}/{repo}` followed by `path`. */
  repoPath(path) {
    return `/repos/${this.owner}/${this.repo}${path}`;
  }
  async graphql(query, variables) {
    const { data } = await this.#send("POST", "/graphql", { query, variables });
    if (data.errors?.length) throw new Error(`GraphQL: ${data.errors.map((e) => e.message).join("; ")}`);
    if (!data.data) throw new Error("GraphQL: empty response");
    return data.data;
  }
  /** A REST call. 404, 409 and 422 come back with their status; any other client error throws. */
  rest(method, path, body) {
    return this.#send(method, path, body);
  }
  async #send(method, path, body) {
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await fetch(`${this.#api}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.#token}`,
            accept: "application/vnd.github+json",
            "content-type": "application/json",
            "user-agent": "merge-gate",
            "x-github-api-version": "2022-11-28"
          },
          body: body === void 0 ? void 0 : JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS)
        });
      } catch (err) {
        if (attempt < ATTEMPTS) {
          await sleep(attempt * 2e3);
          continue;
        }
        throw new Error(`${method} ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (res.status >= 500 && attempt < ATTEMPTS) {
        await sleep(attempt * 2e3);
        continue;
      }
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      if (res.status >= 400 && !TOLERATED.has(res.status)) {
        const message = data?.message ?? text.slice(0, 200);
        throw new Error(`${method} ${path}: ${res.status} ${message}`);
      }
      return { status: res.status, data };
    }
  }
};

// src/model.ts
var LABEL = "merge-gate";
var CONTEXT = "merge-gate";
var COPILOT_LOGIN = "copilot-pull-request-reviewer";
var COPILOT_BOT_ID = "BOT_kgDOCnlnWA";
var COPILOT_WORKFLOW = "Copilot";
var NOTE_MARK = "<!-- merge-gate:unreviewed";
var AWAIT_PREFIX = "MERGE_GATE_AWAIT_";
var COPILOT_TIMEOUT_MIN = 20;
var RULESET_GRACE_MIN = 5;
var REGISTER_WAIT_S = 20;

// src/snapshot.ts
var SNAPSHOT_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      id number state isDraft headRefOid
      labels(first:50){nodes{name}}
      reviewRequests(first:30){nodes{requestedReviewer{__typename ... on Bot{login}}}}
      reviews(last:50,author:"${COPILOT_LOGIN}[bot]",states:[COMMENTED,APPROVED,CHANGES_REQUESTED]){nodes{submittedAt commit{oid} comments{totalCount}}}
      reviewThreads(first:100){pageInfo{hasNextPage endCursor} nodes{isResolved}}
      timelineItems(last:100,itemTypes:[REVIEW_REQUESTED_EVENT,LABELED_EVENT]){nodes{__typename
        ... on ReviewRequestedEvent{createdAt requestedReviewer{__typename ... on Bot{login}}}
        ... on LabeledEvent{createdAt label{name}}}}
      comments(last:100){nodes{id body}}
      commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100){nodes{__typename
        ... on CheckRun{name status conclusion startedAt completedAt checkSuite{workflowRun{workflow{name}}}}
        ... on StatusContext{context state description createdAt}}}}}}}
    }
  }
}`;
var THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{isResolved}}
    }
  }
}`;
var QUEUE_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviewRequests(first:30){nodes{requestedReviewer{__typename ... on Bot{login}}}}
      reviews(author:"${COPILOT_LOGIN}[bot]",states:[COMMENTED,APPROVED,CHANGES_REQUESTED]){totalCount}
    }
  }
}`;
var present = (nodes) => nodes.filter((n) => n !== null);
var NOT_STARTED = "\uFFFF";
function toCheck(c) {
  if (c.__typename === "StatusContext") {
    const state2 = c.state === "SUCCESS" ? "success" : c.state === "PENDING" || c.state === "EXPECTED" ? "pending" : (
      // A superseded deployment (Railway reaps the first of two deploys of one commit) says nothing about the code.
      /cancel/i.test(c.description ?? "") ? "ignored" : "failure"
    );
    return { workflow: "", name: c.context, state: state2, at: c.createdAt };
  }
  const workflow = c.checkSuite?.workflowRun?.workflow?.name ?? "";
  if (c.status !== "COMPLETED") return { workflow, name: c.name, state: "pending", at: c.startedAt ?? NOT_STARTED };
  const state = c.conclusion === "SUCCESS" || c.conclusion === "NEUTRAL" || c.conclusion === "SKIPPED" ? "success" : c.conclusion === "STALE" ? "ignored" : "failure";
  return { workflow, name: c.name, state, at: c.startedAt ?? c.completedAt ?? "" };
}
var NOTE_FIELDS = /head=([0-9a-f]{40}) reason=(quota|ignored|timeout)/;
function toNote(comment) {
  if (!comment.body.startsWith(NOTE_MARK)) return null;
  const m = NOTE_FIELDS.exec(comment.body);
  return m?.[1] && m[2] ? { id: comment.id, head: m[1], reason: m[2] } : null;
}
var isCopilot = (r) => r?.__typename === "Bot" && r.login === COPILOT_LOGIN;
function parseSnapshot(pr) {
  const timeline = present(pr.timelineItems.nodes);
  const latest = (times) => times.filter((t) => !!t).sort().at(-1) ?? null;
  const commit = present(pr.commits.nodes)[0]?.commit;
  const contexts = present(commit?.statusCheckRollup?.contexts.nodes ?? []);
  const gate = contexts.find((c) => c.__typename === "StatusContext" && c.context === CONTEXT);
  const notes = present(pr.comments.nodes).map(toNote).filter((n) => n !== null);
  return {
    id: pr.id,
    number: pr.number,
    open: pr.state === "OPEN",
    draft: pr.isDraft,
    head: pr.headRefOid,
    labeled: present(pr.labels.nodes).some((l) => l.name === LABEL),
    labeledAt: latest(timeline.filter((t) => t.__typename === "LabeledEvent" && t.label?.name === LABEL).map((t) => t.createdAt)),
    copilotQueued: present(pr.reviewRequests.nodes).some((r) => isCopilot(r.requestedReviewer)),
    copilotRequestedAt: latest(
      timeline.filter((t) => t.__typename === "ReviewRequestedEvent" && isCopilot(t.requestedReviewer)).map((t) => t.createdAt)
    ),
    copilotReviews: present(pr.reviews.nodes).filter((r) => r.submittedAt && r.commit).map((r) => ({ commit: r.commit.oid, submittedAt: r.submittedAt, comments: r.comments.totalCount })).sort((a, b) => a.submittedAt.localeCompare(b.submittedAt)),
    unresolvedThreads: present(pr.reviewThreads.nodes).filter((t) => !t.isResolved).length,
    checks: contexts.map(toCheck),
    gateStatus: gate?.__typename === "StatusContext" ? { state: gate.state.toLowerCase(), description: gate.description ?? "" } : null,
    note: notes.at(-1) ?? null
  };
}
async function readSnapshot(gh, number) {
  const vars = { owner: gh.owner, name: gh.repo, number };
  const data = await gh.graphql(SNAPSHOT_QUERY, vars);
  const pr = data.repository.pullRequest;
  if (!pr) return null;
  const snapshot = parseSnapshot(pr);
  let page = pr.reviewThreads.pageInfo;
  while (page.hasNextPage && page.endCursor) {
    const more = await gh.graphql(THREADS_QUERY, {
      ...vars,
      after: page.endCursor
    });
    const threads = more.repository.pullRequest.reviewThreads;
    snapshot.unresolvedThreads += present(threads.nodes).filter((t) => !t.isResolved).length;
    page = threads.pageInfo;
  }
  return snapshot;
}
async function readQueue(gh, number) {
  const data = await gh.graphql(QUEUE_QUERY, { owner: gh.owner, name: gh.repo, number });
  const pr = data.repository.pullRequest;
  return {
    queued: present(pr.reviewRequests.nodes).some((r) => isCopilot(r.requestedReviewer)),
    reviews: pr.reviews.totalCount
  };
}
function parseQuota(raw) {
  const q = raw.quota_snapshots?.premium_interactions;
  if (!q || q.has_quota === void 0 && q.remaining === void 0) return null;
  const remaining = typeof q.remaining === "number" ? q.remaining : null;
  const spent = q.has_quota === false || remaining !== null && remaining <= 0;
  const permitted = q.overage_permitted === true;
  const overageRemaining = permitted && typeof q.overage_entitlement === "number" && typeof q.overage_count === "number" ? q.overage_entitlement - q.overage_count : null;
  const overage = permitted && (overageRemaining === null || overageRemaining > 0);
  const exhausted = !q.unlimited && spent && !overage;
  return {
    exhausted,
    remaining,
    overageRemaining,
    resetAt: raw.quota_reset_date_utc ?? raw.quota_reset_date ?? null
  };
}
async function readQuota(gh) {
  try {
    const res = await gh.rest("GET", "/copilot_internal/user");
    return res.status === 200 && res.data ? parseQuota(res.data) : null;
  } catch {
    return null;
  }
}

// src/verdict.ts
var REASONS = {
  quota: "cr\xE9dits Copilot \xE9puis\xE9s",
  ignored: "demande ignor\xE9e par Copilot (quota ou panne)",
  timeout: `Copilot n\u2019a pas rendu sa revue en ${COPILOT_TIMEOUT_MIN} min`
};
var DESCRIPTION_MAX = 140;
function excluded(c, cfg) {
  return c.workflow === cfg.ownWorkflow || c.workflow === COPILOT_WORKFLOW || c.name === COPILOT_LOGIN || c.name.startsWith(CONTEXT) || cfg.ignoreChecks.includes(c.name);
}
function ciVerdict(checks, cfg) {
  const latest = /* @__PURE__ */ new Map();
  for (const c of checks) {
    if (excluded(c, cfg)) continue;
    const key = `${c.workflow}\0${c.name}`;
    const seen = latest.get(key);
    if (!seen || c.at > seen.at) latest.set(key, c);
  }
  const kept = [...latest.values()].filter((c) => c.state !== "ignored");
  const failing = kept.filter((c) => c.state === "failure").map((c) => c.name);
  const running = kept.filter((c) => c.state === "pending");
  const pending = running.map((c) => c.name);
  for (const name of cfg.requiredChecks) {
    if (!kept.some((c) => c.name === name)) pending.push(name);
  }
  if (kept.length === 0 && cfg.requiredChecks.length === 0) pending.push("aucun check");
  const state = failing.length > 0 ? "red" : pending.length > 0 ? "pending" : "green";
  return { state, failing, pending, statusPending: running.some((c) => c.workflow === "") };
}
function minutesSince(iso, now) {
  return (now.getTime() - Date.parse(iso)) / 6e4;
}
function reviewState(s, cfg, now) {
  const last = s.copilotReviews.at(-1);
  const due = !last;
  if (s.copilotQueued) {
    const since = s.copilotRequestedAt ?? s.labeledAt;
    if (since && minutesSince(since, now) >= COPILOT_TIMEOUT_MIN) {
      return due ? { kind: "unreviewed", reason: "timeout" } : { kind: "done" };
    }
    return { kind: "waiting" };
  }
  if (!due) return { kind: "done" };
  if (s.note?.head === s.head) return { kind: "unreviewed", reason: s.note.reason };
  if (cfg.firstReview === "ruleset") {
    if (!s.labeledAt || minutesSince(s.labeledAt, now) < RULESET_GRACE_MIN) return { kind: "grace" };
  }
  return { kind: "due" };
}
function wantsRequest(s, ci, review) {
  return s.open && review.kind === "due" && s.unresolvedThreads === 0 && ci.state !== "red";
}
function clip(text) {
  return text.length <= DESCRIPTION_MAX ? text : `${text.slice(0, DESCRIPTION_MAX - 1)}\u2026`;
}
function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}
function decide(s, ci, review, quota) {
  const nothing = { label: null, draft: null, request: false, note: null, awaiting: false };
  if (!s.open) return { kind: "closed", ...nothing, status: null };
  if (s.draft && !s.labeled) {
    return {
      kind: "work-draft",
      ...nothing,
      status: { state: "pending", description: "Brouillon de travail \u2014 passer la PR en pr\xEAte pour la confier \xE0 la porte" }
    };
  }
  let r = review;
  let request = false;
  if (wantsRequest(s, ci, r)) {
    if (quota?.exhausted) r = { kind: "unreviewed", reason: "quota" };
    else {
      request = true;
      r = { kind: "waiting" };
    }
  }
  const note = r.kind === "unreviewed" && (s.note?.head !== s.head || s.note.reason !== r.reason) ? r.reason : null;
  if (ci.state === "green" && s.unresolvedThreads === 0 && (r.kind === "done" || r.kind === "unreviewed")) {
    return {
      kind: "open",
      label: s.labeled ? "remove" : null,
      draft: s.draft ? "to-ready" : null,
      request: false,
      note,
      awaiting: false,
      status: r.kind === "unreviewed" ? { state: "success", description: clip(`Pr\xEAte \u2014 NON relue par Copilot : ${REASONS[r.reason]}`) } : { state: "success", description: "Pr\xEAte \u2014 CI verte, relue par Copilot, aucun fil ouvert" }
    };
  }
  const parts = [];
  let authorMustAct = false;
  if (ci.state === "red") {
    authorMustAct = true;
    parts.push(`CI rouge : ${ci.failing.join(", ")}`);
  }
  if (s.unresolvedThreads > 0) {
    authorMustAct = true;
    parts.push(`${plural(s.unresolvedThreads, "fil ouvert", "fils ouverts")} \xE0 traiter`);
  }
  if (r.kind === "waiting") parts.push(request ? "revue Copilot demand\xE9e" : "Copilot relit");
  if (r.kind === "grace") parts.push("attend la revue Copilot du ruleset");
  if (r.kind === "unreviewed") parts.push(`sans revue Copilot (${REASONS[r.reason]})`);
  if (ci.state === "pending") parts.push(`CI en cours : ${ci.pending.join(", ")}`);
  return {
    kind: "hold",
    label: s.labeled ? null : "add",
    draft: s.draft ? null : "to-draft",
    request,
    note,
    awaiting: r.kind === "waiting" || r.kind === "grace" || ci.state === "pending" && ci.statusPending,
    status: { state: authorMustAct ? "failure" : "pending", description: clip(`Gard\xE9e en brouillon \u2014 ${parts.join(" \xB7 ")}`) }
  };
}

// src/gate.ts
var REQUEST = `mutation($pr:ID!,$bot:ID!){requestReviews(input:{pullRequestId:$pr,botIds:[$bot],union:true}){clientMutationId}}`;
var TO_DRAFT = `mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){clientMutationId}}`;
var TO_READY = `mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){clientMutationId}}`;
var ADD_COMMENT = `mutation($id:ID!,$body:String!){addComment(input:{subjectId:$id,body:$body}){clientMutationId}}`;
var EDIT_COMMENT = `mutation($id:ID!,$body:String!){updateIssueComment(input:{id:$id,body:$body}){clientMutationId}}`;
async function requestCopilot(gh, s, waitS) {
  await gh.graphql(REQUEST, { pr: s.id, bot: COPILOT_BOT_ID });
  const deadline = Date.now() + waitS * 1e3;
  for (; ; ) {
    const q = await readQueue(gh, s.number);
    if (q.queued || q.reviews > s.copilotReviews.length) return true;
    if (Date.now() >= deadline) return false;
    await sleep(4e3);
  }
}
function noteBody(head, reason, quota) {
  const reset = reason === "quota" && quota?.resetAt ? ` (remise \xE0 z\xE9ro le ${quota.resetAt.slice(0, 10)})` : "";
  return [
    `${NOTE_MARK} head=${head} reason=${reason} -->`,
    `**Pas de revue Copilot sur \`${head.slice(0, 7)}\`** : ${REASONS[reason]}${reset}.`,
    "",
    "La porte ouvre la PR sans cette revue d\xE8s que la CI est verte et qu\u2019aucun fil n\u2019est ouvert. La relecture de ce commit reste \xE0 faire."
  ].join("\n");
}
async function setStatus(gh, sha, status, runUrl) {
  await gh.rest("POST", gh.repoPath(`/statuses/${sha}`), { ...status, context: CONTEXT, target_url: runUrl });
}
async function syncAwait(gh, s, awaiting) {
  const name = `${AWAIT_PREFIX}${s.number}`;
  if (!awaiting) {
    await gh.rest("DELETE", gh.repoPath(`/actions/variables/${name}`));
    return;
  }
  const res = await gh.rest("PATCH", gh.repoPath(`/actions/variables/${name}`), { name, value: s.head });
  if (res.status === 404) await gh.rest("POST", gh.repoPath("/actions/variables"), { name, value: s.head });
}
async function apply(gh, s, plan, quota, runUrl) {
  try {
    if (plan.label === "add") await gh.rest("POST", gh.repoPath(`/issues/${s.number}/labels`), { labels: [LABEL] });
    if (plan.draft === "to-draft") await gh.graphql(TO_DRAFT, { id: s.id });
    if (plan.draft === "to-ready") await gh.graphql(TO_READY, { id: s.id });
    if (plan.label === "remove") await gh.rest("DELETE", gh.repoPath(`/issues/${s.number}/labels/${LABEL}`));
    if (plan.note) {
      const body = noteBody(s.head, plan.note, quota);
      if (s.note) await gh.graphql(EDIT_COMMENT, { id: s.note.id, body });
      else await gh.graphql(ADD_COMMENT, { id: s.id, body });
    }
    const current = s.gateStatus;
    if (plan.status && (current?.state !== plan.status.state || current.description !== plan.status.description)) {
      await setStatus(gh, s.head, plan.status, runUrl);
    }
    await syncAwait(gh, s, plan.awaiting);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setStatus(gh, s.head, { state: "failure", description: `La porte n\u2019a pas pu agir : ${message}`.slice(0, 140) }, runUrl).catch(
      () => void 0
    );
    throw err;
  }
}
async function gatePullRequest(gh, number, cfg, runUrl, opts = {}) {
  const s = await readSnapshot(gh, number);
  if (!s) return `#${number} \u2014 introuvable`;
  const ci = ciVerdict(s.checks, cfg);
  const review = reviewState(s, cfg, opts.now ?? /* @__PURE__ */ new Date());
  const quota = wantsRequest(s, ci, review) ? await readQuota(gh) : null;
  let plan = decide(s, ci, review, quota);
  let requested = "";
  if (plan.request) {
    const registered = await requestCopilot(gh, s, opts.registerWaitS ?? REGISTER_WAIT_S);
    requested = registered ? " \xB7 Copilot demand\xE9" : " \xB7 demande ignor\xE9e";
    if (!registered) plan = decide(s, ci, { kind: "unreviewed", reason: "ignored" }, quota);
  }
  await apply(gh, s, plan, quota, runUrl);
  const facts = `CI ${ci.state} \xB7 ${s.unresolvedThreads} fil(s) \xB7 revue ${review.kind}${quota ? ` \xB7 quota ${quota.remaining ?? "?"}${quota.overageRemaining === null ? "" : ` (overage ${quota.overageRemaining})`}` : ""}`;
  return `#${number} ${s.head.slice(0, 7)} \u2014 ${facts}${requested} \u2192 ${plan.kind}${plan.status ? ` : ${plan.status.description}` : ""}`;
}

// src/targets.ts
async function targets(gh, eventName, event) {
  if (event.pull_request) return [event.pull_request.number];
  if (eventName === "workflow_run" && event.workflow_run) {
    const listed = (event.workflow_run.pull_requests ?? []).map((p) => p.number);
    if (listed.length > 0) return listed;
    const sha = event.workflow_run.head_sha;
    const { data } = await gh.rest(
      "GET",
      gh.repoPath(`/commits/${sha}/pulls`)
    );
    return (Array.isArray(data) ? data : []).filter((p) => p.state === "open" && p.head.sha === sha).map((p) => p.number);
  }
  if (eventName === "workflow_dispatch" && Number(event.inputs?.pr) > 0) return [Number(event.inputs?.pr)];
  if (eventName === "workflow_dispatch") {
    const { data } = await gh.rest(
      "GET",
      gh.repoPath("/pulls?state=open&per_page=100")
    );
    return data.filter((p) => !p.draft || p.labels.some((l) => l.name === LABEL)).map((p) => p.number);
  }
  if (eventName === "schedule") {
    const { data } = await gh.rest("GET", gh.repoPath("/actions/variables?per_page=30"));
    return (data.variables ?? []).filter((v) => v.name.startsWith(AWAIT_PREFIX)).map((v) => Number(v.name.slice(AWAIT_PREFIX.length))).filter((n) => n > 0);
  }
  return [];
}

// src/main.ts
var input = (name) => (process.env[`INPUT_${name.toUpperCase()}`] ?? "").trim();
var list = (value) => value.split(/[\s,]+/).filter(Boolean);
async function main() {
  const token = input("token");
  if (!token) {
    console.log("::warning title=merge-gate::Aucun jeton (secret GATE_TOKEN absent, ou run Dependabot) : rien n\u2019est fait.");
    return;
  }
  const firstReview = input("first-review") || "gate";
  if (firstReview !== "gate" && firstReview !== "ruleset") throw new Error(`first-review: \xAB ${firstReview} \xBB \u2014 gate ou ruleset`);
  const cfg = {
    firstReview,
    requiredChecks: list(input("required-checks")),
    ignoreChecks: list(input("ignore-checks")),
    ownWorkflow: process.env["GITHUB_WORKFLOW"] ?? ""
  };
  const [owner = "", repo = ""] = (process.env["GITHUB_REPOSITORY"] ?? "").split("/");
  const gh = new GitHub(token, owner, repo, process.env["GITHUB_API_URL"]);
  const runUrl = `${process.env["GITHUB_SERVER_URL"] ?? "https://github.com"}/${owner}/${repo}/actions/runs/${process.env["GITHUB_RUN_ID"] ?? ""}`;
  const event = JSON.parse(readFileSync(process.env["GITHUB_EVENT_PATH"] ?? "", "utf8"));
  const numbers = await targets(gh, process.env["GITHUB_EVENT_NAME"] ?? "", event);
  if (numbers.length === 0) console.log("Aucune pull request \xE0 examiner.");
  let failed = false;
  for (const n of numbers) {
    try {
      console.log(await gatePullRequest(gh, n, cfg, runUrl));
    } catch (err) {
      failed = true;
      console.log(`::error title=merge-gate #${n}::${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failed) process.exitCode = 1;
}
await main().catch((err) => {
  console.log(`::error title=merge-gate::${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
