// src/main.ts
import { readFileSync } from "node:fs";

// src/github.ts
var ATTEMPTS = 3;
var TIMEOUT_MS = 15e3;
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var TOLERATED = /* @__PURE__ */ new Set([404, 409, 422]);
var HttpError = class extends Error {
  status;
  /** GitHub's rate limiting (429, or a 403 that says so): it passes, unlike a refusal. */
  throttled;
  constructor(status, message, throttled = false) {
    super(message);
    this.status = status;
    this.throttled = throttled;
  }
  /** An outage, no answer at all (status 0), or a rate limit: it passes, and a later run asks again. */
  get transient() {
    return this.status === 0 || this.status >= 500 || this.throttled;
  }
};
function isThrottled(status, headers, message) {
  if (status === 429) return true;
  if (status !== 403) return false;
  return headers.has("retry-after") || headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(message);
}
var GitHub = class {
  owner;
  repo;
  #token;
  #api;
  /** The wait before a second try; the third waits twice as long. */
  #retryWaitMs;
  constructor(token, owner, repo, api = "https://api.github.com", retryWaitMs = 2e3) {
    this.#token = token;
    this.owner = owner;
    this.repo = repo;
    this.#api = api.replace(/\/$/, "");
    this.#retryWaitMs = retryWaitMs;
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
      let text;
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
        text = await res.text();
      } catch (err) {
        if (attempt < ATTEMPTS) {
          await sleep(attempt * this.#retryWaitMs);
          continue;
        }
        throw new HttpError(0, `${method} ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (res.status >= 500 && attempt < ATTEMPTS) {
        await sleep(attempt * this.#retryWaitMs);
        continue;
      }
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      if (res.status >= 400 && !TOLERATED.has(res.status)) {
        const message = data?.message ?? text.slice(0, 200);
        throw new HttpError(res.status, `${method} ${path}: ${res.status} ${message}`, isThrottled(res.status, res.headers, message));
      }
      return { status: res.status, data };
    }
  }
};

// src/model.ts
var LABEL = "merge-gate";
var CONTEXT = "merge-gate";
var COPILOT_LOGIN = "copilot-pull-request-reviewer";
var REVIEW_EFFORTS = ["lite", "balanced", "max", "adaptive"];
var COPILOT_WORKFLOW = "Copilot";
var NOTE_MARK = "<!-- merge-gate:unreviewed";
var LOVABLE_MARK = "<!-- merge-gate:lovable-review";
var AWAIT_PREFIX = "MERGE_GATE_AWAIT_";
var COPILOT_TIMEOUT_MIN = 20;
var RULESET_GRACE_MIN = 5;
var REGISTER_WAIT_S = 20;

// src/diff.ts
var LOCK_FILES = /* @__PURE__ */ new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lockb",
  "composer.lock",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "Gemfile.lock",
  "go.sum"
]);
var GENERATED_DIR = /(?:^|\/)(?:dist|vendor|node_modules|\.next|coverage|__snapshots__)\//;
var GENERATED_EXT = /\.(?:min\.js|min\.css|map|snap|svg|png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|otf|eot|mp3|mp4|zip|gz)$/i;
function reviewable(f) {
  if (!f.patch || f.status === "removed") return false;
  const name = f.path.slice(f.path.lastIndexOf("/") + 1);
  return !LOCK_FILES.has(name) && !GENERATED_DIR.test(f.path) && !GENERATED_EXT.test(f.path);
}
var HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
function annotate(patch) {
  const out = [];
  const commentable = /* @__PURE__ */ new Set();
  const added = /* @__PURE__ */ new Set();
  let next = 0;
  for (const line of patch.split("\n")) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      next = Number(hunk[1]);
      out.push(line);
      continue;
    }
    if (line === "" || line.startsWith("\\")) continue;
    const code = line.slice(1);
    if (line[0] === "-") {
      out.push(`${" ".repeat(6)} - ${code}`);
      continue;
    }
    commentable.add(next);
    if (line[0] === "+") added.add(next);
    out.push(`${String(next).padStart(6)} ${line[0] === "+" ? "+" : " "} ${code}`);
    next++;
  }
  return { text: out.join("\n"), commentable, added };
}
function numbered(content) {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line, i) => `${String(i + 1).padStart(6)}| ${line}`).join("\n");
}
var weight = (u) => u.path.length + u.diff.length + (u.content?.length ?? 0) + 64;
var CONTINUED = "[\u2026 the hunk goes on from the previous part]";
function splitHunk(hunk, budget) {
  if (hunk.length <= budget) return [hunk];
  const room = budget - CONTINUED.length - 1;
  const parts = [];
  let current = "";
  for (const raw of hunk.split("\n")) {
    const line = raw.length > room ? `${raw.slice(0, room - 20)} [\u2026 line cut]` : raw;
    if (current && current.length + line.length + 1 > budget) {
      parts.push(current);
      current = CONTINUED;
    }
    current = current ? `${current}
${line}` : line;
  }
  if (current) parts.push(current);
  return parts;
}
function splitDiff(diff, budget) {
  const hunks = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@") || hunks.length === 0) hunks.push(line);
    else hunks[hunks.length - 1] += `
${line}`;
  }
  const pieces = [];
  let current = "";
  for (const h of hunks.flatMap((hunk) => splitHunk(hunk, budget))) {
    if (current && current.length + h.length + 1 > budget) {
      pieces.push(current);
      current = "";
    }
    current = current ? `${current}
${h}` : h;
  }
  if (current) pieces.push(current);
  return pieces;
}
function pack(units, budget) {
  const fitted = [];
  for (const u of [...units].sort((a, b) => a.path.localeCompare(b.path))) {
    if (weight(u) <= budget) fitted.push(u);
    else if (weight({ ...u, content: null }) <= budget) fitted.push({ ...u, content: null });
    else {
      const pieces = splitDiff(u.diff, budget - u.path.length - 128);
      pieces.forEach((diff, i) => fitted.push({ path: u.path, diff, content: null, part: `${i + 1}/${pieces.length}` }));
    }
  }
  const chunks = [];
  let current = [];
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
function anchor(line, a, reach = 3) {
  if (a.commentable.has(line)) return line;
  for (const lines of [a.added, a.commentable]) {
    for (let d = 1; d <= reach; d++) {
      if (lines.has(line - d)) return line - d;
      if (lines.has(line + d)) return line + d;
    }
  }
  return null;
}

// src/prompts.ts
var FINDING_PROPERTIES = {
  path: { type: "string", description: "The file, exactly as its header names it." },
  line: { type: "integer", description: "The new-file line number printed left of a + or context line of that file\u2019s diff." },
  severity: { type: "string", enum: ["high", "medium", "low"] },
  category: { type: "string", description: "A few words: the checklist item it falls under." },
  title: { type: "string", description: "The defect in one sentence, at most 100 characters." },
  explanation: { type: "string", description: "The concrete failure: which input or state, what goes wrong, why \u2014 2 to 5 sentences." },
  fix: { type: "string", description: "The fix, in one or two sentences or a short code excerpt; empty when obvious." }
};
var FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: { type: "object", properties: FINDING_PROPERTIES, required: Object.keys(FINDING_PROPERTIES) }
    }
  },
  required: ["findings"]
};
var VERDICTS_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer", description: "The candidate\u2019s id." },
          keep: { type: "boolean" },
          reason: { type: "string", description: "Why it is kept or rejected, citing the code \u2014 one or two sentences." },
          ...FINDING_PROPERTIES
        },
        required: ["id", "keep", "reason", ...Object.keys(FINDING_PROPERTIES)]
      }
    }
  },
  required: ["verdicts"]
};
var CHECKLIST = `Checklist \u2014 ordered by what reviewers find most on these repositories. Walk every file against all of it.
1. Stale prose: every changed comment, docstring, README or doc line, log or error message, and every claim of the pull request description \u2014 does the code now do exactly that? Check every verb of a touched doc comment against the code.
2. Swallowed errors: every catch / except / .catch() / "|| true" \u2014 does it rethrow or report, or does it return normally and break the caller's retry, close or rollback contract? A catch that turns a TypeError into "empty data" hides a bug.
3. User-facing text and locales: untranslated or wrong-language strings, a hard-coded string where i18n is claimed, locale-specific regexes or word lists.
4. CI and configuration: a changed workflow, deployment config, path filter or exemption list \u2014 is the new file exercised by the job it should trigger? Does a job bypass the gate? Is a token scoped to the step that needs it?
5. Tests that cannot fail: for each new assertion, what real input turns it red? A fixture that closes the very window the test claims to judge, a vacuous every()/some() on an empty array, an assertion that holds whatever the code does.
6. Migrations and SQL: explicit casts, NOT NULL on existing rows, a reversible down(), backfills that rerun on each deploy, a migration outside the directory the config scans.
7. Concurrency on a second path: for any shared or claimed state (a row's status, an in-flight set, a lock, a ref, a transaction), every acquire and release site \u2014 release on the error path, deletion between claim and use, a second caller.
8. Contract drift: a changed signature, return type, payload or interface \u2014 does every call site and declared type still match?
9. Edge cases of each new condition: null, undefined, empty, zero, false and '' (x || fallback when x may be 0), sign, off-by-one, time zones and month rollover, state not reset on an early return, filters that silently drop rows.
10. Security: secrets or tokens reaching logs, URLs or files; trusted proxy headers; cache keys without user scoping; injection.
11. Accessibility of new UI: accessible names, alt text, keyboard focus, aria-pressed on toggles.
12. Lifecycle: effect dependency lists, cleanup on unmount, a subscription or timer never released, the error path.
13. Performance: unbounded arrays or caches, N+1 queries in a loop, work repeated per call that could be done once.
14. Business logic: trace each new branch by hand with one concrete input against what the pull request says it does \u2014 the largest single source of real defects.`;
var RULES = `Rules:
- Report real defects only: what would break, mislead, or fail in production, in CI or for the next reader. No style, formatting, naming or import-order remarks, no praise, no summary, no "consider adding logging", no speculation without a failure you can describe.
- Every finding names a concrete failure: this input or this state \u2192 this wrong result.
- Read the whole file content given before reporting: never flag what the code already handles elsewhere.
- Anchor each finding on a line of the diff: the number printed left of a "+" or context line of that file. Prefer the added line that causes the defect.
- severity: high = wrong behaviour, data loss, a security hole, a broken build or deployment; medium = a real bug on an edge case, a test that cannot fail, prose the code contradicts; low = minor but real.
- At most 15 findings, the most serious first. An empty list is a valid answer: do not invent findings to have some.
- Write title, explanation and fix in the language of the pull request's title and description.`;
function header(pr) {
  return [
    `Repository: ${pr.repository}`,
    `Pull request title: ${pr.title}`,
    `Pull request description:
${pr.description.trim() || "(none)"}`,
    // Without it a model reads a source change whose build output it never sees, and reports that build as not updated.
    pr.unshown.length > 0 ? `Also changed by the pull request, not shown here (removed, machine-written \u2014 lock files, build output \u2014, binary, or a diff too large for GitHub to show; the pull request does change them, and a removal can be a finding of its own): ${pr.unshown.join(", ")}` : "",
    pr.guidance ? `Repository guidelines (the project's own rules \u2014 a change that breaks one is a finding):
${pr.guidance}` : ""
  ].filter(Boolean).join("\n\n");
}
var FINDER_SYSTEM = `You are a senior software engineer doing the one review this pull request gets before it is merged, in place of GitHub Copilot code review. Your findings become review threads the author must answer, so each must be worth a thread. Think hard: trace the code, follow each changed value to where it is used, and check the claims against the code.

${CHECKLIST}

${RULES}`;
function finderPrompt(pr, chunk) {
  const files = chunk.files.map(
    (f) => [
      `===== FILE ${f.path}${f.part ? ` (diff part ${f.part})` : ""} =====`,
      `--- diff (new-file line numbers on the left; "+" added, "-" removed, blank context) ---`,
      f.diff,
      f.content === null ? "--- full content: not included (too large) ---" : `--- full content at the head ---
${f.content}`
    ].join("\n")
  );
  return [
    header(pr),
    `Files changed by the pull request (${chunk.allFiles.length}): ${chunk.allFiles.join(", ")}`,
    `This call holds ${chunk.part}. Review these files:`,
    ...files
  ].join("\n\n");
}
var CROSS_SYSTEM = `You are a senior software engineer reviewing a whole pull request for the defects that only show across files. Other reviewers read each file in depth; you look at the change as a whole. Think hard.

Look for:
- every claim of the title and description ("removed", "replaced", "all \u2026 now", "no more \u2026", "fixes \u2026") that the diff does not carry out, or contradicts;
- a change applied on one path but not on its twin (a second caller, a second implementation, the other platform, the other locale);
- a signature, payload, setting or name changed in one file while another changed file still uses the old one;
- documentation, comments or configuration in one file that another file's change makes false;
- new behaviour with no test, or a test changed so that it no longer judges what it claims;
- behaviour the diff changes that the description does not mention.

${RULES}`;
function crossPrompt(pr, diffs, cut2) {
  return [
    header(pr),
    `The whole diff (${diffs.length} files${cut2 ? ", each cut to fit one call" : ""}; new-file line numbers on the left):`,
    ...diffs.map((d) => `===== FILE ${d.path} =====
${d.diff}`)
  ].join("\n\n");
}
var VERIFIER_SYSTEM = `You verify candidate review findings that other reviewers proposed on a pull request. Only what you keep is posted, as review threads the author must answer: a false positive wastes their time, a missed real defect ships. Think hard and check each candidate against the code itself.

For each candidate:
- keep it only if the defect is real, caused or touched by this pull request, and worth a thread: trace the code to confirm the failure it describes;
- reject it when the code already handles the case (say where), when it is speculative, a matter of style or taste, outside the change, or a duplicate of another candidate (keep the clearest one, reject the others as "duplicate of #id");
- when you keep it, return the final comment: correct the path and the line to the exact diff line the defect sits on (a number printed left of a "+" or context line), set the severity honestly, and rewrite title, explanation and fix so they are precise, short and checkable \u2014 in the language of the pull request's title and description.

Return one verdict for every candidate id.`;
function verifierPrompt(pr, chunk, candidates) {
  return [
    finderPrompt(pr, chunk),
    `===== CANDIDATE FINDINGS (${candidates.length}) =====`,
    JSON.stringify(candidates, null, 1)
  ].join("\n\n");
}

// src/relay.ts
var RelayError = class extends Error {
  kind;
  status;
  constructor(kind, status, message) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
};
var CALL_TIMEOUT_MS = 135e3;
var RATE_WAITS_MS = [5e3, 2e4];
function chatBody(req) {
  const body = {
    model: req.model,
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.user }
    ]
  };
  if (req.effort) body["reasoning_effort"] = req.effort;
  if (req.model.startsWith("openai/")) {
    body["response_format"] = { type: "json_schema", json_schema: { name: "answer", schema: req.schema } };
  } else {
    body["tools"] = [{ type: "function", function: { name: "answer", description: "Give the answer.", parameters: req.schema } }];
    body["tool_choice"] = { type: "function", function: { name: "answer" } };
  }
  return body;
}
function parseAnswer(raw) {
  const choice = raw.choices?.[0];
  const message = choice?.message;
  if (!message) throw new RelayError("error", 200, "r\xE9ponse sans message");
  if (message.refusal) throw new RelayError("error", 200, `refus du mod\xE8le : ${message.refusal.slice(0, 120)}`);
  const text = message.tool_calls?.[0]?.function?.arguments ?? message.content ?? "";
  const json = text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1");
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    const kind = choice.finish_reason === "length" ? "timeout" : "error";
    throw new RelayError(kind, 200, `r\xE9ponse illisible (finish_reason ${choice.finish_reason ?? "?"})`);
  }
  const u = raw.usage ?? {};
  return {
    value,
    usage: { prompt: u.prompt_tokens ?? 0, completion: u.completion_tokens ?? 0, reasoning: u.completion_tokens_details?.reasoning_tokens ?? 0 },
    model: raw.model ?? ""
  };
}
function failureOf(status) {
  if (status === 402) return "credits";
  if (status === 401 || status === 403) return "token";
  if (status === 429) return "rate";
  if (status === 524 || status === 522 || status === 504) return "timeout";
  return "error";
}
var LovableRelay = class {
  #url;
  #token;
  #caller;
  #timeoutMs;
  constructor(url, token, caller, timeoutMs = CALL_TIMEOUT_MS) {
    this.#url = url.replace(/\/+$/, "");
    this.#token = token;
    this.#caller = caller;
    this.#timeoutMs = timeoutMs;
  }
  /** `text` without the relay's secrets — its token, its address, its host — should an answer echo them. */
  #redact(text) {
    let host = "";
    try {
      host = new URL(this.#url).host;
    } catch {
    }
    return [this.#token, this.#url, host].filter((x) => x.length >= 3).reduce((t, x) => t.split(x).join("\u2026"), text);
  }
  async json(req) {
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(`${this.#url}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.#token}`, "content-type": "application/json", "x-relay-caller": this.#caller },
          body: JSON.stringify(chatBody(req)),
          signal: AbortSignal.timeout(this.#timeoutMs)
        });
      } catch (err) {
        const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        throw new RelayError(timeout ? "timeout" : "error", 0, timeout ? `pas de r\xE9ponse en ${this.#timeoutMs / 1e3} s` : "connexion au relais impossible");
      }
      const wait = RATE_WAITS_MS[attempt];
      if (res.status === 429 && wait !== void 0) {
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        const text = this.#redact(await res.text().catch(() => ""));
        throw new RelayError(failureOf(res.status), res.status, `relais ${res.status} ${text.replace(/\s+/g, " ").slice(0, 120)}`.trim());
      }
      const raw = await res.json().catch(() => null);
      if (!raw) throw new RelayError("error", res.status, "r\xE9ponse non JSON");
      const answer = parseAnswer(raw);
      return { value: answer.value, usage: answer.usage, model: answer.model || req.model, ms: Date.now() - started };
    }
  }
};

// src/review.ts
var DEEP = { id: "openai/gpt-6.1-terra", label: "GPT-6.1 terra", ladder: ["high", "medium", "low"] };
var SECOND = { id: "openai/gpt-6.1-sol", label: "GPT-6.1 sol", ladder: ["high", "medium", "low"] };
var WIDE = { id: "google/gemini-4-argon", label: "Gemini 4 argon", ladder: ["medium", null] };
var LIMITS = {
  chunk: 36e3,
  cross: 9e4,
  concurrency: 3,
  find: 6 * 6e4,
  verify: 12 * 6e4,
  threads: 25,
  batch: 10
};
var GUIDANCE_FILES = [".github/copilot-instructions.md", "AGENTS.md", "CLAUDE.md"];
var GUIDANCE_MAX = 12e3;
var CONTENT_MAX = 15e4;
var FILE_PAGES = 30;
async function readText(gh, path, ref) {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const res = await gh.rest("GET", gh.repoPath(`/contents/${encoded}?ref=${ref}`));
  if (res.status !== 200 || res.data?.type !== "file" || res.data.encoding !== "base64" || !res.data.content) return null;
  const text = Buffer.from(res.data.content, "base64").toString("utf8");
  return text.includes("\0") ? null : text;
}
async function each(items, n, work) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}
async function gather(gh, number, head) {
  const pr = await gh.rest(
    "GET",
    gh.repoPath(`/pulls/${number}`)
  );
  if (pr.status !== 200 || pr.data?.head?.sha !== head) return null;
  const files = [];
  for (let page = 1; page <= FILE_PAGES; page++) {
    const res = await gh.rest(
      "GET",
      gh.repoPath(`/pulls/${number}/files?per_page=100&page=${page}`)
    );
    if (res.status !== 200 || !Array.isArray(res.data)) throw new Error(`fichiers de la PR refus\xE9s par GitHub (${res.status})`);
    const listed = res.data;
    files.push(...listed.map((f) => ({ path: f.filename, status: f.status, patch: f.patch ?? null })));
    if (listed.length < 100) break;
  }
  const expected = pr.data?.changed_files;
  if (typeof expected === "number" && files.length < expected) throw new Error(`liste des fichiers incompl\xE8te (${files.length} sur ${expected})`);
  const kept = files.filter(reviewable);
  const skipped = files.filter((f) => !reviewable(f)).map((f) => f.path);
  const contents = /* @__PURE__ */ new Map();
  await each(kept, 6, async (f) => {
    const text = await readText(gh, f.path, head);
    contents.set(f.path, text !== null && text.length <= CONTENT_MAX ? numbered(text) : null);
  });
  const guidance = [];
  for (const path of GUIDANCE_FILES) {
    const text = await readText(gh, path, head);
    if (text?.trim()) guidance.push(`--- ${path}${text.length > GUIDANCE_MAX ? " (cut)" : ""} ---
${text.slice(0, GUIDANCE_MAX)}`);
  }
  const reviewed = kept.map((f) => ({ path: f.path, ann: annotate(f.patch ?? "") }));
  return {
    text: {
      repository: `${gh.owner}/${gh.repo}`,
      title: pr.data.title ?? "",
      description: pr.data.body ?? "",
      guidance: guidance.join("\n\n"),
      unshown: files.filter((f) => !reviewable(f)).map((f) => `${f.path} (${f.status})`)
    },
    reviewed,
    units: reviewed.map((r) => ({ path: r.path, diff: r.ann.text, content: contents.get(r.path) ?? null })),
    skipped
  };
}
function unitLines(u) {
  return new Set([...u.diff.matchAll(/^ *(\d+) [+ ] /gm)].map((m) => Number(m[1])));
}
var SEVERITIES = ["high", "medium", "low"];
var RANK = { high: 0, medium: 1, low: 2 };
function asFinding(raw) {
  const f = raw;
  if (!f || typeof f.path !== "string" || typeof f.title !== "string" || typeof f.explanation !== "string") return null;
  const line = Number(f.line);
  if (!Number.isInteger(line) || line < 1 || !f.title.trim()) return null;
  return {
    path: f.path.trim().replace(/^\.?\//, ""),
    line,
    severity: SEVERITIES.includes(f.severity) ? f.severity : "medium",
    category: typeof f.category === "string" ? f.category : "",
    title: f.title.trim(),
    explanation: f.explanation.trim(),
    fix: typeof f.fix === "string" ? f.fix.trim() : ""
  };
}
var Session = class {
  tally = { calls: 0, ok: 0, failures: {}, prompt: 0, completion: 0, reasoning: 0, answered: /* @__PURE__ */ new Map() };
  fatal = null;
  #relay;
  #clock;
  #log;
  #concurrency;
  /** Per model, the rung its calls start at: lowered after two timeouts at one rung. */
  #start = /* @__PURE__ */ new Map();
  #timeouts = /* @__PURE__ */ new Map();
  constructor(relay, clock, log, concurrency) {
    this.#relay = relay;
    this.#clock = clock;
    this.#log = log;
    this.#concurrency = concurrency;
  }
  /** One answer from `spec`, down its effort ladder; null when every rung failed or time ran out. */
  async ask(spec, task, system, user, schema, deadline) {
    for (let rung = this.#start.get(spec.id) ?? 0; rung < spec.ladder.length; rung++) {
      if (this.fatal || this.#clock() >= deadline) return null;
      const effort = spec.ladder[rung] ?? null;
      this.tally.calls++;
      try {
        const a = await this.#relay.json({ model: spec.id, effort, system, user, schema });
        this.tally.ok++;
        this.tally.prompt += a.usage.prompt;
        this.tally.completion += a.usage.completion;
        this.tally.reasoning += a.usage.reasoning;
        const efforts = this.tally.answered.get(a.model) ?? /* @__PURE__ */ new Set();
        efforts.add(effort ?? "d\xE9faut");
        this.tally.answered.set(a.model, efforts);
        this.#log(`  ${task} \xB7 ${spec.label} ${effort ?? "d\xE9faut"} \u2192 ${Math.round(a.ms / 1e3)} s, ${a.usage.prompt} \u2192 ${a.usage.completion} jetons`);
        return a;
      } catch (err) {
        const e = err instanceof RelayError ? err : new RelayError("error", 0, err instanceof Error ? err.message : String(err));
        this.tally.failures[e.kind] = (this.tally.failures[e.kind] ?? 0) + 1;
        this.#log(`  ${task} \xB7 ${spec.label} ${effort ?? "d\xE9faut"} \u2192 ${e.kind} (${e.message})`);
        if (e.kind === "credits" || e.kind === "token") {
          this.fatal = e;
          return null;
        }
        if (e.kind === "rate") return null;
        if (e.kind === "timeout") {
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
  async run(tasks, deadline) {
    let started = 0;
    await each(tasks, this.#concurrency, async (task) => {
      if (this.fatal || this.#clock() >= deadline) return;
      started++;
      await task();
    });
    return started;
  }
};
var SEVERITY_LABEL = { high: "importante", medium: "moyenne", low: "mineure" };
var COMMENT_MAX = 8e3;
var ITEM_MAX = 1500;
var LIST_MAX = 15e3;
var cut = (text, max) => text.length <= max ? text : `${text.slice(0, max - 1)}\u2026`;
function fit(items, max) {
  const kept = [];
  let size = 0;
  for (const [i, item] of items.entries()) {
    if (size + item.length + 1 > max) {
      kept.push(`- \u2026 et ${items.length - i} de plus, coup\xE9e(s) : GitHub limite la taille d\u2019une revue.`);
      break;
    }
    kept.push(item);
    size += item.length + 1;
  }
  return kept;
}
function commentBody(f) {
  return cut(
    [
      `**${f.title}** \xB7 ${SEVERITY_LABEL[f.severity]}${f.verified ? "" : " \xB7 non v\xE9rifi\xE9e (temps ou relais \xE9puis\xE9 avant la v\xE9rification)"}`,
      "",
      f.explanation,
      ...f.fix ? ["", `**Correctif propos\xE9** : ${f.fix}`] : [],
      "",
      `<sub>Relecture Lovable \xB7 ${f.by}${f.category ? ` \xB7 ${f.category}` : ""}</sub>`
    ].join("\n"),
    COMMENT_MAX
  );
}
var listItem = (f) => cut(
  `- \`${f.path}:${f.line}\` \u2014 **${f.title}** (${SEVERITY_LABEL[f.severity]}${f.verified ? "" : ", non v\xE9rifi\xE9e"}). ${f.explanation}${f.fix ? ` *Correctif propos\xE9 :* ${f.fix}` : ""}`,
  ITEM_MAX
);
async function post(gh, number, head, threads, body) {
  const strict = threads.filter((t) => t.onAdded);
  const attempts = [threads, ...strict.length < threads.length ? [strict] : [], ...threads.length > 0 ? [[]] : []];
  for (const posted of attempts) {
    const res = await gh.rest("POST", gh.repoPath(`/pulls/${number}/reviews`), {
      commit_id: head,
      event: "COMMENT",
      body: body(threads.filter((t) => !posted.includes(t))),
      comments: posted.map((t) => ({ path: t.path, line: t.line, side: "RIGHT", body: commentBody(t) }))
    });
    if (res.status === 200 || res.status === 201) return posted.length;
    if (res.status !== 422) throw new Error(`POST /pulls/${number}/reviews: ${res.status}`);
  }
  throw new Error(`POST /pulls/${number}/reviews: 422`);
}
var seconds = (ms) => `${Math.round(ms / 1e3)} s`;
async function reviewWithLovable(gh, relay, input2, opts = {}) {
  const clock = opts.clock ?? Date.now;
  const log = opts.log ?? (() => void 0);
  const limits = { ...LIMITS, ...opts.limits };
  const t0 = clock();
  const g = await gather(gh, input2.number, input2.head);
  if (!g) return { kind: "moved" };
  const chunks = pack(g.units, limits.chunk);
  const allFiles = g.reviewed.map((r) => r.path);
  const chunkTexts = chunks.map((units, i) => ({ part: `part ${i + 1} of ${chunks.length}`, allFiles, files: units }));
  const session = new Session(relay, clock, log, limits.concurrency);
  log(`Lovable : ${g.reviewed.length} fichier(s) en ${chunks.length} lot(s), ${g.skipped.length} ignor\xE9(s)`);
  const candidates = [];
  let finders = 0;
  const read = /* @__PURE__ */ new Set();
  const find = (spec, task, system, user, chunk) => async () => {
    const a = await session.ask(spec, task, system, user, FINDINGS_SCHEMA, t0 + limits.find);
    const found = a?.value?.findings;
    if (!Array.isArray(found)) {
      if (a) log(`  ${task} : r\xE9ponse hors sch\xE9ma, compt\xE9e comme un \xE9chec`);
      return;
    }
    finders++;
    if (chunk !== null) read.add(chunk);
    for (const raw of found) {
      const f = asFinding(raw);
      if (f) candidates.push({ ...f, id: candidates.length + 1, by: spec.label });
    }
  };
  const searches = [];
  chunkTexts.forEach((c, i) => {
    const user = finderPrompt(g.text, c);
    searches.push(find(DEEP, `lot ${i + 1}`, FINDER_SYSTEM, user, i), find(WIDE, `lot ${i + 1}`, FINDER_SYSTEM, user, i));
    if (i === 0 && g.reviewed.length > 1) {
      const per = Math.floor(limits.cross / g.reviewed.length);
      const cutDiffs = g.reviewed.some((r) => r.ann.text.length > per);
      const diffs = g.reviewed.map((r) => ({ path: r.path, diff: r.ann.text.length > per ? `${r.ann.text.slice(0, per)}
[\u2026 cut]` : r.ann.text }));
      searches.push(find(DEEP, "transversal", CROSS_SYSTEM, crossPrompt(g.text, diffs, cutDiffs), null));
    }
  });
  chunkTexts.forEach((c, i) => searches.push(find(SECOND, `lot ${i + 1}`, FINDER_SYSTEM, finderPrompt(g.text, c), i)));
  const searched = await session.run(searches, t0 + limits.find);
  if (chunks.length > 0 && finders === 0) {
    const failure = session.fatal?.kind === "credits" ? "credits" : session.fatal?.kind === "token" ? "token" : "unavailable";
    return { kind: "failed", failure, threads: 0, line: `relecture Lovable impossible (${failure}) apr\xE8s ${session.tally.calls} appel(s), ${seconds(clock() - t0)}` };
  }
  const lines = chunks.map((units) => units.map((u) => ({ path: u.path, lines: unitLines(u) })));
  const chunkOf = (c) => {
    const exact = lines.findIndex((us) => us.some((u) => u.path === c.path && u.lines.has(c.line)));
    return exact >= 0 ? exact : lines.findIndex((us) => us.some((u) => u.path === c.path));
  };
  const byChunk = /* @__PURE__ */ new Map();
  let strays = 0;
  for (const c of candidates) {
    const i = chunkOf(c);
    if (i < 0) strays++;
    else byChunk.set(i, [...byChunk.get(i) ?? [], c]);
  }
  const finals = [];
  const unverified = [];
  let rejected = 0;
  const batches = [];
  for (const [i, list2] of [...byChunk.entries()].sort((a, b) => a[0] - b[0])) {
    const sorted = list2.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    for (let k = 0; k < sorted.length; k += limits.batch) batches.push({ chunk: i, list: sorted.slice(k, k + limits.batch), judged: false });
  }
  const verify = (b) => async () => {
    const texts = b.list.map(({ by: _, ...c }) => c);
    const user = verifierPrompt(g.text, chunkTexts[b.chunk], texts);
    const deadline = t0 + limits.verify;
    const task = `v\xE9rif. lot ${b.chunk + 1}`;
    const listed = (spec) => session.ask(spec, task, VERIFIER_SYSTEM, user, VERDICTS_SCHEMA, deadline).then((a) => {
      const list3 = a?.value?.verdicts;
      return Array.isArray(list3) ? list3 : null;
    });
    const list2 = await listed(DEEP) ?? await listed(WIDE);
    if (!list2) return;
    b.judged = true;
    const verdicts = /* @__PURE__ */ new Map();
    for (const v of list2) {
      const id = Number(v?.id);
      if (Number.isInteger(id)) verdicts.set(id, v);
    }
    for (const c of b.list) {
      const v = verdicts.get(c.id);
      const f = v?.keep === true ? asFinding(v) : null;
      if (f) finals.push({ ...f, by: c.by, verified: true });
      else if (v?.keep === false) rejected++;
      else unverified.push(c);
    }
  };
  await session.run(batches.map(verify), t0 + limits.verify);
  for (const b of batches) if (!b.judged) unverified.push(...b.list);
  if (strays > 0) log(`  ${strays} candidate(s) sur un fichier hors du diff relu, \xE9cart\xE9e(s)`);
  const interrupted = session.fatal ? session.fatal.kind === "credits" ? "credits" : "token" : null;
  if (interrupted && finals.length + unverified.length === 0) {
    return { kind: "failed", failure: interrupted, threads: 0, line: `relecture Lovable interrompue (${interrupted}), rien de trouv\xE9 avant, ${session.tally.calls} appel(s), ${seconds(clock() - t0)}` };
  }
  const ann = new Map(g.reviewed.map((r) => [r.path, r.ann]));
  const placed = /* @__PURE__ */ new Map();
  const inBody = [];
  const asFinal = ({ id: _, ...c }) => ({ ...c, verified: false });
  const unverifiedHigh = unverified.filter((c) => c.severity === "high").map(asFinal);
  for (const f of [...finals, ...unverifiedHigh].sort((a, b) => RANK[a.severity] - RANK[b.severity])) {
    const a = ann.get(f.path);
    const at = a ? anchor(f.line, a) : null;
    if (!a || at === null || f.severity === "low") {
      inBody.push(f);
      continue;
    }
    const key = `${f.path}:${at}`;
    if (!placed.has(key)) placed.set(key, { ...f, line: at, onAdded: a.added.has(at) });
    else inBody.push(f);
  }
  const threads = [...placed.values()].sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.path.localeCompare(b.path) || a.line - b.line);
  inBody.push(...threads.splice(limits.threads));
  const notVerified = unverified.filter((c) => c.severity === "medium").map(asFinal);
  const unread = [...new Set(chunks.flatMap((units, i) => read.has(i) ? [] : units.map((u) => u.path)))];
  const tally = session.tally;
  const answered = [...tally.answered.entries()].map(([m, e]) => `${m} (${[...e].join(", ")})`).join(", ");
  const failures = Object.entries(tally.failures).map(([k, n]) => `${k} ${n}`).join(", ");
  const skipped = g.skipped.slice(0, 12).map((p) => `\`${p}\``).join(", ") + (g.skipped.length > 12 ? "\u2026" : "");
  const body = (refused) => {
    const offThread = [...refused, ...inBody];
    return [
      ...interrupted ? [
        "### Relecture Lovable interrompue",
        `Copilot n\u2019a pas relu cette PR (${input2.why}), et le relais Lovable s\u2019est arr\xEAt\xE9 en cours de relecture (${interrupted === "credits" ? "cr\xE9dits Lovable \xE9puis\xE9s" : "jeton refus\xE9"}) : voici ce qu\u2019il avait trouv\xE9, pour information. Cette relecture ne compte pas comme la revue de la PR.`
      ] : [
        `${LOVABLE_MARK} head=${input2.head} -->`,
        "### Relecture Lovable",
        `Copilot n\u2019a pas relu cette PR (${input2.why}) : la porte de fusion l\u2019a fait relire par le relais Lovable, pay\xE9 en cr\xE9dits Lovable.`
      ],
      "",
      g.reviewed.length === 0 ? `Rien \xE0 relire : ${g.skipped.length} fichier(s), aucun avec un diff \xE9crit \xE0 la main (verrous, build, binaires, fichiers supprim\xE9s, ou diff trop gros pour que GitHub le montre).` : `**${threads.length - refused.length} remarque(s) en fil** sur \`${input2.head.slice(0, 7)}\` \xB7 ${finals.length} retenue(s) et ${rejected} \xE9cart\xE9e(s) \xE0 la v\xE9rification, ${unverified.length} non v\xE9rifi\xE9e(s), sur ${candidates.length} candidate(s).`,
      ...unread.length > 0 ? [
        "",
        interrupted ? "#### Non relus (relais arr\xEAt\xE9 avant leur lecture)" : "#### Non relus (temps ou relais \xE9puis\xE9 avant leur lecture ; la relecture compte quand m\xEAme comme la revue de la PR)",
        ...fit(unread.map((p) => `- \`${p}\``), LIST_MAX)
      ] : [],
      ...offThread.length > 0 ? ["", "#### Hors fil (mineures, sans ligne du diff, sur une ligne d\xE9j\xE0 comment\xE9e, au-del\xE0 du plafond de fils, ou refus\xE9es par GitHub)", ...fit(offThread.map(listItem), LIST_MAX)] : [],
      ...notVerified.length > 0 ? ["", "#### Non v\xE9rifi\xE9es (temps ou relais \xE9puis\xE9 avant la v\xE9rification, ou laiss\xE9es sans verdict par le v\xE9rificateur)", ...fit(notVerified.map(listItem), LIST_MAX)] : [],
      "",
      "<details><summary>Comment cette relecture a \xE9t\xE9 faite</summary>",
      "",
      `- ${g.reviewed.length} fichier(s) relu(s) en ${chunks.length} lot(s), avec leur contenu entier quand il tient dans un appel${g.skipped.length > 0 ? ` ; ${g.skipped.length} ignor\xE9(s) : ${skipped}` : ""}.`,
      `- Recherche : chaque lot par ${DEEP.label} et ${WIDE.label}, puis ${SECOND.label} tant que le temps le permet, et une passe transversale sur le diff entier \u2014 ${searched} recherche(s) lanc\xE9e(s) sur ${searches.length}.`,
      `- V\xE9rification de chaque candidate contre le code par ${DEEP.label} (${WIDE.label} en secours).`,
      `- ${tally.ok} appel(s) r\xE9ussi(s) sur ${tally.calls}${failures ? ` (\xE9checs : ${failures})` : ""} \xB7 ${tally.prompt} jetons lus, ${tally.completion} \xE9crits dont ${tally.reasoning} de raisonnement \xB7 ${seconds(clock() - t0)}.`,
      `- Mod\xE8les qui ont r\xE9pondu : ${answered || "aucun"}.`,
      "",
      "</details>"
    ].join("\n");
  };
  const now = await gh.rest("GET", gh.repoPath(`/pulls/${input2.number}`));
  if (now.status !== 200 || now.data?.head?.sha !== input2.head) {
    log(`Lovable : la t\xEAte a boug\xE9 pendant la relecture (ou la PR est introuvable), rien n\u2019est post\xE9`);
    return { kind: "moved" };
  }
  const posted = await post(gh, input2.number, input2.head, threads, body);
  const facts = `${posted} fil(s), ${finals.length}/${candidates.length} candidate(s) retenue(s)${unread.length > 0 ? `, ${unread.length} fichier(s) non relu(s)` : ""}, ${tally.ok}/${tally.calls} appels, ${tally.prompt} \u2192 ${tally.completion} jetons, ${seconds(clock() - t0)}`;
  if (interrupted) return { kind: "failed", failure: interrupted, threads: posted, line: `relecture Lovable interrompue (${interrupted}), post\xE9e pour information : ${facts}` };
  return { kind: "reviewed", threads: posted, line: `relue par Lovable : ${facts}` };
}

// src/snapshot.ts
var SNAPSHOT_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  viewer{login}
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      id number state isDraft headRefOid
      labels(first:50){nodes{name}}
      reviewRequests(first:30){nodes{requestedReviewer{__typename ... on Bot{login}}}}
      reviews(last:50,author:"${COPILOT_LOGIN}[bot]",states:[COMMENTED,APPROVED,CHANGES_REQUESTED]){nodes{submittedAt commit{oid} comments{totalCount}}}
      gateReviews:reviews(first:100,states:[COMMENTED]){nodes{author{login} body submittedAt commit{oid}}}
      lateGateReviews:reviews(last:100,states:[COMMENTED]){nodes{author{login} body submittedAt commit{oid}}}
      reviewThreads(first:100){pageInfo{hasNextPage endCursor} nodes{isResolved}}
      timelineItems(last:100,itemTypes:[REVIEW_REQUESTED_EVENT,LABELED_EVENT]){nodes{__typename
        ... on ReviewRequestedEvent{createdAt requestedReviewer{__typename ... on Bot{login}}}
        ... on LabeledEvent{createdAt label{name}}}}
      comments(last:100){nodes{id body}}
      commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100){nodes{__typename
        ... on CheckRun{name status conclusion startedAt completedAt checkSuite{conclusion workflowRun{databaseId workflow{databaseId name}}}}
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
var runId = (c) => c.checkSuite?.workflowRun?.databaseId ?? null;
function supersededRuns(contexts) {
  const newest = /* @__PURE__ */ new Map();
  const cancelled = [];
  for (const c of contexts) {
    if (c.__typename !== "CheckRun") continue;
    const wf = c.checkSuite?.workflowRun?.workflow;
    const workflow = wf ? wf.databaseId != null ? `#${wf.databaseId}` : wf.name : void 0;
    const id = runId(c);
    if (!workflow || id === null) continue;
    newest.set(workflow, Math.max(newest.get(workflow) ?? 0, id));
    if (c.checkSuite?.conclusion === "CANCELLED") cancelled.push({ workflow, id });
  }
  return new Set(cancelled.filter((r) => r.id < (newest.get(r.workflow) ?? 0)).map((r) => r.id));
}
function toCheck(c, superseded) {
  if (c.__typename === "StatusContext") {
    const state2 = c.state === "SUCCESS" ? "success" : c.state === "PENDING" || c.state === "EXPECTED" ? "pending" : (
      // A superseded deployment (Railway reaps the first of two deploys of one commit) says nothing about the code.
      /cancel/i.test(c.description ?? "") ? "ignored" : "failure"
    );
    return { workflow: "", name: c.context, state: state2, at: c.createdAt };
  }
  const wf = c.checkSuite?.workflowRun?.workflow;
  const workflow = wf?.name ?? "";
  const of = wf?.databaseId != null ? { workflow, workflowId: wf.databaseId } : { workflow };
  const at = c.startedAt ?? c.completedAt ?? "";
  const id = runId(c);
  if (id !== null && superseded.has(id) && c.checkSuite?.conclusion === "CANCELLED") return { ...of, name: c.name, state: "ignored", at };
  if (c.status !== "COMPLETED") return { ...of, name: c.name, state: "pending", at: c.startedAt ?? NOT_STARTED };
  const state = c.conclusion === "SUCCESS" || c.conclusion === "NEUTRAL" || c.conclusion === "SKIPPED" ? "success" : c.conclusion === "STALE" ? "ignored" : c.conclusion === "CANCELLED" ? "cancelled" : "failure";
  return { ...of, name: c.name, state, at };
}
var NOTE_FIELDS = /head=([0-9a-f]{40}) reason=(quota|overage|refused|ignored|timeout)(?: lovable=(credits|token|unavailable))?/;
function toNote(comment) {
  if (!comment.body.startsWith(NOTE_MARK)) return null;
  const m = NOTE_FIELDS.exec(comment.body);
  return m?.[1] && m[2] ? { id: comment.id, head: m[1], reason: m[2], lovable: m[3] ?? null } : null;
}
var isCopilot = (r) => r?.__typename === "Bot" && r.login === COPILOT_LOGIN;
function parseSnapshot(pr, viewer = "") {
  const timeline = present(pr.timelineItems.nodes);
  const latest = (times) => times.filter((t) => !!t).sort().at(-1) ?? null;
  const commit = present(pr.commits.nodes)[0]?.commit;
  const contexts = present(commit?.statusCheckRollup?.contexts.nodes ?? []);
  const superseded = supersededRuns(contexts);
  const gate = contexts.find((c) => c.__typename === "StatusContext" && c.context === CONTEXT);
  const notes = present(pr.comments.nodes).map(toNote).filter((n) => n !== null);
  const lovable = present([...pr.gateReviews?.nodes ?? [], ...pr.lateGateReviews?.nodes ?? []]).find(
    (r) => !!viewer && r.author?.login === viewer && r.body.startsWith(LOVABLE_MARK) && r.commit && r.submittedAt
  );
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
    lovableReview: lovable ? { commit: lovable.commit.oid, submittedAt: lovable.submittedAt } : null,
    unresolvedThreads: present(pr.reviewThreads.nodes).filter((t) => !t.isResolved).length,
    checks: contexts.map((c) => toCheck(c, superseded)),
    gateStatus: gate?.__typename === "StatusContext" ? { state: gate.state.toLowerCase(), description: gate.description ?? "", at: gate.createdAt } : null,
    note: notes.at(-1) ?? null
  };
}
async function readSnapshot(gh, number) {
  const vars = { owner: gh.owner, name: gh.repo, number };
  const data = await gh.graphql(SNAPSHOT_QUERY, vars);
  const pr = data.repository.pullRequest;
  if (!pr) return null;
  const snapshot = parseSnapshot(pr, data.viewer?.login);
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
  const room = permitted && (overageRemaining === null || overageRemaining > 0);
  const exhausted = !q.unlimited && spent && !room;
  return {
    exhausted,
    overage: !q.unlimited && spent && room,
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
  overage: "cr\xE9dits Copilot inclus \xE9puis\xE9s, d\xE9passement payant \xE9vit\xE9",
  refused: "demande refus\xE9e par GitHub (cr\xE9dits, d\xE9p\xF4t ou compte non \xE9ligible)",
  ignored: "demande ignor\xE9e par Copilot (quota ou panne)",
  timeout: `Copilot n\u2019a pas rendu sa revue en ${COPILOT_TIMEOUT_MIN} min`
};
var LOVABLE_REASONS = {
  credits: "cr\xE9dits Lovable \xE9puis\xE9s",
  token: "jeton du relais Lovable refus\xE9",
  unavailable: "relais Lovable sans r\xE9ponse"
};
var DESCRIPTION_MAX = 140;
function excluded(c, cfg) {
  return c.workflow === cfg.ownWorkflow || c.workflow === COPILOT_WORKFLOW || c.name === COPILOT_LOGIN || c.name.startsWith(CONTEXT) || cfg.ignoreChecks.includes(c.name);
}
var WEIGHT = { success: 2, failure: 2, pending: 2, cancelled: 1, ignored: 0 };
function speaking(a, b) {
  if (!a) return b;
  const weight2 = WEIGHT[b.state] - WEIGHT[a.state];
  if (weight2 !== 0) return weight2 > 0 ? b : a;
  return b.at > a.at ? b : a;
}
function ciVerdict(checks, cfg) {
  const latest = /* @__PURE__ */ new Map();
  for (const c of checks) {
    if (excluded(c, cfg)) continue;
    const key = `${c.workflowId ?? c.workflow}\0${c.name}`;
    latest.set(key, speaking(latest.get(key), c));
  }
  const kept = [...latest.values()].filter((c) => c.state !== "ignored");
  const failing = kept.filter((c) => c.state === "failure" || c.state === "cancelled").map((c) => c.name);
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
var LOVABLE_RUN_MIN = 20;
var relayingText = (reason) => `Lovable relit (${REASONS[reason]})`;
var lovableLaterText = (reason) => `relecture Lovable \xE0 venir (${REASONS[reason]})`;
function relaying(s, now) {
  const st = s.gateStatus;
  if (st?.state !== "pending" || !st.at || minutesSince(st.at, now) >= LOVABLE_RUN_MIN) return null;
  return Object.keys(REASONS).find((reason) => st.description.includes(relayingText(reason))) ?? null;
}
function reviewState(s, cfg, now) {
  const last = s.copilotReviews.at(-1);
  const due = !last && !s.lovableReview;
  const done = { kind: "done", by: last ? "copilot" : "lovable" };
  const inFlight = due ? relaying(s, now) : null;
  if (inFlight) return { kind: "relaying", reason: inFlight };
  const noted = s.note?.head === s.head ? s.note : null;
  if (s.copilotQueued) {
    const since = s.copilotRequestedAt ?? s.labeledAt;
    if (since && minutesSince(since, now) >= COPILOT_TIMEOUT_MIN) {
      return due ? { kind: "unreviewed", reason: "timeout", lovable: noted?.lovable ?? null } : done;
    }
    return { kind: "waiting" };
  }
  if (!due) return done;
  if (noted) return { kind: "unreviewed", reason: noted.reason, lovable: noted.lovable };
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
function decide(s, ci, review, quota, lovable = false, relayFree = true) {
  const nothing = { label: null, draft: null, request: false, note: null, awaiting: false, review };
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
    if (quota?.exhausted) r = { kind: "unreviewed", reason: "quota", lovable: null };
    else if (lovable && quota?.overage) r = { kind: "unreviewed", reason: "overage", lovable: null };
    else {
      request = true;
      r = { kind: "waiting" };
    }
  }
  if (lovable && r.kind === "unreviewed" && r.lovable === null) r = { kind: "lovable", reason: r.reason };
  const note = r.kind === "unreviewed" && (s.note?.head !== s.head || s.note.reason !== r.reason || s.note.lovable !== r.lovable) ? { reason: r.reason, lovable: r.lovable } : null;
  if (ci.state === "green" && s.unresolvedThreads === 0 && (r.kind === "done" || r.kind === "unreviewed")) {
    return {
      kind: "open",
      label: s.labeled ? "remove" : null,
      draft: s.draft ? "to-ready" : null,
      request: false,
      note,
      awaiting: false,
      review: r,
      status: r.kind === "unreviewed" ? {
        state: "success",
        description: clip(`Pr\xEAte \u2014 NON relue par Copilot : ${REASONS[r.reason]}${r.lovable ? ` \xB7 ni par Lovable : ${LOVABLE_REASONS[r.lovable]}` : ""}`)
      } : r.by === "lovable" ? { state: "success", description: "Pr\xEAte \u2014 CI verte, relue par Lovable \xE0 la place de Copilot, aucun fil ouvert" } : { state: "success", description: "Pr\xEAte \u2014 CI verte, relue par Copilot, aucun fil ouvert" }
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
  if (r.kind === "lovable") parts.push(authorMustAct || !relayFree ? lovableLaterText(r.reason) : relayingText(r.reason));
  if (r.kind === "relaying") parts.push(relayingText(r.reason));
  if (ci.state === "pending") parts.push(`CI en cours : ${ci.pending.join(", ")}`);
  return {
    kind: "hold",
    label: s.labeled ? null : "add",
    draft: s.draft ? null : "to-draft",
    request,
    note,
    review: r,
    // A run that dies during the relay's review leaves the sweep to start it again.
    awaiting: r.kind === "waiting" || r.kind === "grace" || r.kind === "relaying" || r.kind === "lovable" && !authorMustAct || ci.state === "pending" && ci.statusPending,
    // While another run has the relay review the head, its status is the lock other runs read, stamped
    // with its time: left as it is, or a red CI rewritten as a failure would hide the review in flight.
    status: r.kind === "relaying" ? null : { state: authorMustAct ? "failure" : "pending", description: clip(`Gard\xE9e en brouillon \u2014 ${parts.join(" \xB7 ")}`) }
  };
}
function wantsLovable(s, ci, plan) {
  return plan.kind === "hold" && plan.review.kind === "lovable" && s.unresolvedThreads === 0 && ci.state !== "red";
}

// src/gate.ts
var TO_DRAFT = `mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){clientMutationId}}`;
var TO_READY = `mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){clientMutationId}}`;
var ADD_COMMENT = `mutation($id:ID!,$body:String!){addComment(input:{subjectId:$id,body:$body}){clientMutationId}}`;
var EDIT_COMMENT = `mutation($id:ID!,$body:String!){updateIssueComment(input:{id:$id,body:$body}){clientMutationId}}`;
async function requestCopilot(gh, s, effort, waitS) {
  let res;
  try {
    res = await gh.rest("POST", gh.repoPath(`/pulls/${s.number}/copilot-code-review`), { review_effort: effort });
  } catch (err) {
    if (err instanceof HttpError && !err.transient) return { reason: "refused", detail: `refus\xE9e, ${err.status}` };
    throw err;
  }
  if (res.status === 422 && res.data?.failure_reason === "INVALID_REVIEW_EFFORT") {
    throw new Error(`copilot-effort \xAB ${effort} \xBB refus\xE9 par GitHub : ${res.data.message ?? ""}`);
  }
  if (res.status !== 201 && res.status !== 409) {
    return { reason: "refused", detail: `refus\xE9e, ${res.status}${res.data?.failure_reason ? ` ${res.data.failure_reason}` : ""}` };
  }
  const deadline = Date.now() + waitS * 1e3;
  for (; ; ) {
    const q = await readQueue(gh, s.number);
    if (q.queued || q.reviews > s.copilotReviews.length) return null;
    if (Date.now() >= deadline) return { reason: "ignored", detail: res.status === 409 ? "en attente hors file" : "ignor\xE9e" };
    await sleep(4e3);
  }
}
function noteBody(head, reason, quota, lovable = null) {
  const reset = (reason === "quota" || reason === "overage") && quota?.resetAt ? ` (remise \xE0 z\xE9ro le ${quota.resetAt.slice(0, 10)})` : "";
  return [
    `${NOTE_MARK} head=${head} reason=${reason}${lovable ? ` lovable=${lovable}` : ""} -->`,
    `**Pas de revue Copilot sur \`${head.slice(0, 7)}\`** : ${REASONS[reason]}${reset}.`,
    ...lovable ? ["", `**Ni de relecture Lovable** : ${LOVABLE_REASONS[lovable]}.`] : [],
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
async function apply(gh, s, plan, quota, runUrl, restamp = false) {
  try {
    if (plan.label === "add") await gh.rest("POST", gh.repoPath(`/issues/${s.number}/labels`), { labels: [LABEL] });
    if (plan.draft === "to-draft") await gh.graphql(TO_DRAFT, { id: s.id });
    if (plan.draft === "to-ready") await gh.graphql(TO_READY, { id: s.id });
    if (plan.label === "remove") await gh.rest("DELETE", gh.repoPath(`/issues/${s.number}/labels/${LABEL}`));
    if (plan.note) {
      const body = noteBody(s.head, plan.note.reason, quota, plan.note.lovable);
      if (s.note) await gh.graphql(EDIT_COMMENT, { id: s.note.id, body });
      else await gh.graphql(ADD_COMMENT, { id: s.id, body });
    }
    const current = s.gateStatus;
    if (plan.status && (restamp || current?.state !== plan.status.state || current.description !== plan.status.description)) {
      await setStatus(gh, s.head, plan.status, runUrl);
    }
    await syncAwait(gh, s, plan.awaiting);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (plan.review.kind !== "relaying") {
      await setStatus(gh, s.head, { state: "failure", description: `La porte n\u2019a pas pu agir : ${message}`.slice(0, 140) }, runUrl).catch(
        () => void 0
      );
    }
    throw err;
  }
}
async function gatePullRequest(gh, number, cfg, runUrl, opts = {}) {
  let s = await readSnapshot(gh, number);
  if (!s) return `#${number} \u2014 introuvable`;
  const now = opts.now ?? /* @__PURE__ */ new Date();
  const lovable = cfg.lovable && opts.relay !== void 0;
  const relayFree = !opts.relayTurn?.taken;
  let ci = ciVerdict(s.checks, cfg);
  const review = reviewState(s, cfg, now);
  const quota = wantsRequest(s, ci, review) ? await readQuota(gh) : null;
  let plan = decide(s, ci, review, quota, lovable, relayFree);
  let requested = "";
  if (plan.request) {
    const failure = await requestCopilot(gh, s, cfg.copilotEffort, opts.registerWaitS ?? REGISTER_WAIT_S);
    requested = failure === null ? ` \xB7 Copilot demand\xE9 (${cfg.copilotEffort})` : ` \xB7 demande ${failure.detail}`;
    if (failure !== null) plan = decide(s, ci, { kind: "unreviewed", reason: failure.reason, lovable: null }, quota, lovable, relayFree);
  }
  let reviewed = "";
  if (opts.relay && relayFree && wantsLovable(s, ci, plan)) {
    if (opts.relayTurn) opts.relayTurn.taken = true;
    await apply(gh, s, plan, quota, runUrl, true);
    const reason = plan.review.reason;
    let outcome;
    try {
      outcome = await reviewWithLovable(gh, opts.relay, { number, head: s.head, why: REASONS[reason] }, opts.review);
    } catch (err) {
      if (err instanceof HttpError && err.transient) throw err;
      const message = err instanceof Error ? err.message : String(err);
      outcome = { kind: "failed", failure: "unavailable", threads: 0, line: `relecture Lovable en \xE9chec : ${message}` };
    }
    if (outcome.kind === "moved") return `#${number} ${s.head.slice(0, 7)} \u2014 la t\xEAte a boug\xE9 pendant la relecture, rien n\u2019est post\xE9 : le run de la nouvelle t\xEAte d\xE9cidera`;
    reviewed = ` \xB7 ${outcome.line}`;
    const fresh = await readSnapshot(gh, number);
    if (!fresh) return `#${number} \u2014 introuvable`;
    if (fresh.head !== s.head) return `#${number} ${s.head.slice(0, 7)} \u2014 ${outcome.line} \xB7 la t\xEAte a boug\xE9 depuis : son run d\xE9cidera`;
    ci = ciVerdict(fresh.checks, cfg);
    if (outcome.kind === "reviewed") {
      s = {
        ...fresh,
        lovableReview: fresh.lovableReview ?? { commit: s.head, submittedAt: now.toISOString() },
        unresolvedThreads: Math.max(fresh.unresolvedThreads, outcome.threads)
      };
      plan = decide(s, ci, reviewState(s, cfg, now), quota, lovable);
    } else {
      s = { ...fresh, unresolvedThreads: Math.max(fresh.unresolvedThreads, outcome.threads) };
      const current = reviewState(s, cfg, now);
      plan = decide(s, ci, current.kind === "done" ? current : { kind: "unreviewed", reason, lovable: outcome.failure }, quota, lovable);
    }
  }
  await apply(gh, s, plan, quota, runUrl);
  const facts = `CI ${ci.state} \xB7 ${s.unresolvedThreads} fil(s) \xB7 revue ${review.kind}${quota ? ` \xB7 quota ${quota.remaining ?? "?"}${quota.overageRemaining === null ? "" : ` (overage ${quota.overageRemaining})`}` : ""}`;
  return `#${number} ${s.head.slice(0, 7)} \u2014 ${facts}${requested}${reviewed} \u2192 ${plan.kind}${plan.status ? ` : ${plan.status.description}` : ""}`;
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
var isEffort = (value) => REVIEW_EFFORTS.includes(value);
async function main() {
  const token = input("token");
  if (!token) {
    console.log("::warning title=merge-gate::Aucun jeton (secret GATE_TOKEN absent, ou run Dependabot) : rien n\u2019est fait.");
    return;
  }
  const firstReview = input("first-review") || "gate";
  if (firstReview !== "gate" && firstReview !== "ruleset") throw new Error(`first-review: \xAB ${firstReview} \xBB \u2014 gate ou ruleset`);
  const effort = input("copilot-effort").toLowerCase() || "lite";
  if (!isEffort(effort)) throw new Error(`copilot-effort: \xAB ${effort} \xBB \u2014 ${REVIEW_EFFORTS.join(", ")}`);
  const copilotEffort = effort;
  const relayUrl = input("lovable-relay-url");
  const relayToken = input("lovable-relay-token");
  if (!relayUrl !== !relayToken) console.log("::warning title=merge-gate::Un seul des deux secrets du relais Lovable (LOVABLE_RELAY_URL, LOVABLE_RELAY_TOKEN) : pas de relecture Lovable.");
  const [owner = "", repo = ""] = (process.env["GITHUB_REPOSITORY"] ?? "").split("/");
  const relay = relayUrl && relayToken ? new LovableRelay(relayUrl, relayToken, `merge-gate:${repo}`) : void 0;
  const cfg = {
    firstReview,
    copilotEffort,
    requiredChecks: list(input("required-checks")),
    ignoreChecks: list(input("ignore-checks")),
    ownWorkflow: process.env["GITHUB_WORKFLOW"] ?? "",
    lovable: relay !== void 0
  };
  const gh = new GitHub(token, owner, repo, process.env["GITHUB_API_URL"]);
  const runUrl = `${process.env["GITHUB_SERVER_URL"] ?? "https://github.com"}/${owner}/${repo}/actions/runs/${process.env["GITHUB_RUN_ID"] ?? ""}`;
  const event = JSON.parse(readFileSync(process.env["GITHUB_EVENT_PATH"] ?? "", "utf8"));
  const numbers = await targets(gh, process.env["GITHUB_EVENT_NAME"] ?? "", event);
  if (numbers.length === 0) console.log("Aucune pull request \xE0 examiner.");
  let failed = false;
  const relayTurn = { taken: false };
  for (const n of numbers) {
    try {
      console.log(await gatePullRequest(gh, n, cfg, runUrl, { relay, relayTurn, review: { log: (line) => console.log(line) } }));
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
