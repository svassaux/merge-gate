export interface Response<T> {
  status: number;
  data: T;
}

const ATTEMPTS = 3;
const TIMEOUT_MS = 15_000;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Answers the REST calls may return without it being an error; any other 4xx throws. */
const TOLERATED = new Set([404, 409, 422]);

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

  constructor(token: string, owner: string, repo: string, api = 'https://api.github.com') {
    this.#token = token;
    this.owner = owner;
    this.repo = repo;
    this.#api = api.replace(/\/$/, '');
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
      } catch (err) {
        if (attempt < ATTEMPTS) {
          await sleep(attempt * 2_000);
          continue;
        }
        throw new Error(`${method} ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (res.status >= 500 && attempt < ATTEMPTS) {
        await sleep(attempt * 2_000);
        continue;
      }
      const text = await res.text();
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      if (res.status >= 400 && !TOLERATED.has(res.status)) {
        const message = (data as { message?: string } | null)?.message ?? text.slice(0, 200);
        throw new Error(`${method} ${path}: ${res.status} ${message}`);
      }
      return { status: res.status, data: data as T };
    }
  }
}
