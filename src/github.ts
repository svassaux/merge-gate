export interface Response<T> {
  status: number;
  data: T;
}

const ATTEMPTS = 3;
const TIMEOUT_MS = 15_000;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Answers the REST calls may return without it being an error; any other 4xx throws. */
const TOLERATED = new Set([404, 409, 422]);

/** A REST answer outside TOLERATED, with its status, so a caller can tell a refusal from an outage. */
export class HttpError extends Error {
  readonly status: number;
  /** GitHub's rate limiting (429, or a 403 that says so): it passes, unlike a refusal. */
  readonly throttled: boolean;

  constructor(status: number, message: string, throttled = false) {
    super(message);
    this.status = status;
    this.throttled = throttled;
  }

  /** An outage, no answer at all (status 0), or a rate limit: it passes, and a later run asks again. */
  get transient(): boolean {
    return this.status === 0 || this.status >= 500 || this.throttled;
  }
}

/**
 * GitHub answers a rate limit with 429, or with 403 carrying `retry-after` (secondary limit) or
 * `x-ratelimit-remaining: 0` (primary limit), and a message that names the rate limit. Not retried
 * here: the run fails, and the next one — a push, a CI run, the sweep — asks again.
 */
export function isThrottled(status: number, headers: Headers, message: string): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;
  return headers.has('retry-after') || headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(message);
}

/** What the gate needs from GitHub — the client below, or a fake in the tests. */
export interface Api {
  readonly owner: string;
  readonly repo: string;
  repoPath(path: string): string;
  graphql<T>(query: string, variables: Record<string, unknown>): Promise<T>;
  rest<T = unknown>(method: string, path: string, body?: unknown): Promise<Response<T>>;
}

/** A thin GitHub client over fetch: no dependency, retries on network errors and 5xx. */
export class GitHub implements Api {
  readonly owner: string;
  readonly repo: string;
  readonly #token: string;
  readonly #api: string;
  /** The wait before a second try; the third waits twice as long. */
  readonly #retryWaitMs: number;

  constructor(token: string, owner: string, repo: string, api = 'https://api.github.com', retryWaitMs = 2_000) {
    this.#token = token;
    this.owner = owner;
    this.repo = repo;
    this.#api = api.replace(/\/$/, '');
    this.#retryWaitMs = retryWaitMs;
  }

  /** `/repos/{owner}/{repo}` followed by `path`. */
  repoPath(path: string): string {
    return `/repos/${this.owner}/${this.repo}${path}`;
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const { data } = await this.#send<{ data?: T; errors?: { message: string }[] }>('POST', '/graphql', { query, variables });
    if (data.errors?.length) throw new Error(`GraphQL: ${data.errors.map((e) => e.message).join('; ')}`);
    if (!data.data) throw new Error('GraphQL: empty response');
    return data.data;
  }

  /** A REST call. 404, 409 and 422 come back with their status; any other client error throws. */
  rest<T = unknown>(method: string, path: string, body?: unknown): Promise<Response<T>> {
    return this.#send<T>(method, path, body);
  }

  async #send<T>(method: string, path: string, body?: unknown): Promise<Response<T>> {
    for (let attempt = 1; ; attempt++) {
      let res: globalThis.Response;
      let text: string;
      try {
        res = await fetch(`${this.#api}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.#token}`,
            accept: 'application/vnd.github+json',
            'content-type': 'application/json',
            'user-agent': 'merge-gate',
            'x-github-api-version': '2022-11-28',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        // Read under the same guard: a connection cut halfway through the body is a network failure too.
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
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      if (res.status >= 400 && !TOLERATED.has(res.status)) {
        const message = (data as { message?: string } | null)?.message ?? text.slice(0, 200);
        throw new HttpError(res.status, `${method} ${path}: ${res.status} ${message}`, isThrottled(res.status, res.headers, message));
      }
      return { status: res.status, data: data as T };
    }
  }
}
