import { sleep } from './github.ts';

/**
 * The Lovable relay: an OpenAI-style `POST /chat/completions` in front of Lovable's AI gateway, paid in
 * the owner's Lovable credits. Its address and token reach the gate as secrets (LOVABLE_RELAY_URL,
 * LOVABLE_RELAY_TOKEN) and appear in no message: a public repository's run logs are public.
 */

/** `reasoning_effort` as the gateway takes it; null leaves the model's default. */
export type Effort = 'high' | 'medium' | 'low' | null;

/**
 * Why a call yielded nothing. `credits` (402) and `token` (401, 403) stop the whole review; `rate` (429)
 * gives up that call; `timeout` and `error` cost one rung of the effort ladder.
 */
export type RelayFailure = 'credits' | 'token' | 'rate' | 'timeout' | 'error';

export class RelayError extends Error {
  readonly kind: RelayFailure;
  readonly status: number;

  constructor(kind: RelayFailure, status: number, message: string) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export interface Usage {
  prompt: number;
  completion: number;
  reasoning: number;
}

export interface JsonRequest {
  model: string;
  effort: Effort;
  system: string;
  user: string;
  /** The JSON schema the answer follows. */
  schema: object;
}

export interface JsonAnswer<T> {
  value: T;
  usage: Usage;
  /** The model that answered, as the gateway names it: a retired id is served by its successor. */
  model: string;
  ms: number;
}

/** What the review needs from the relay — the client below, or a fake in the tests. */
export interface Relay {
  json<T>(req: JsonRequest): Promise<JsonAnswer<T>>;
}

/**
 * A call the relay has not answered by then never will: Lovable's hosting answers 524 at about 126 s,
 * measured on 2026-11-19 (five calls, every one between 126.0 and 126.3 s). Waiting a little longer
 * than that lets the 524 come back instead of guessing it.
 */
export const CALL_TIMEOUT_MS = 135_000;
/** Waits before a second and a third try on 429: the relay is for moderate, personal rates. */
const RATE_WAITS_MS = [5_000, 20_000];

interface RawAnswer {
  model?: string;
  choices?: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null; tool_calls?: { function?: { arguments?: string } }[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
}

/** The request body. GPT gets a JSON response format; Gemini a forced function call (GPT refuses one while it reasons). */
export function chatBody(req: JsonRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content: req.user },
    ],
  };
  if (req.effort) body['reasoning_effort'] = req.effort;
  if (req.model.startsWith('openai/')) {
    body['response_format'] = { type: 'json_schema', json_schema: { name: 'answer', schema: req.schema } };
  } else {
    body['tools'] = [{ type: 'function', function: { name: 'answer', description: 'Give the answer.', parameters: req.schema } }];
    body['tool_choice'] = { type: 'function', function: { name: 'answer' } };
  }
  return body;
}

/** The answer's JSON, from the forced call or the content; a fenced block is unwrapped. */
export function parseAnswer(raw: RawAnswer): { value: unknown; usage: Usage; model: string } {
  const choice = raw.choices?.[0];
  const message = choice?.message;
  if (!message) throw new RelayError('error', 200, 'réponse sans message');
  if (message.refusal) throw new RelayError('error', 200, `refus du modèle : ${message.refusal.slice(0, 120)}`);
  const text = message.tool_calls?.[0]?.function?.arguments ?? message.content ?? '';
  const json = text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1');
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    // An empty answer cut at its length is a timeout in disguise: the model spent its room thinking.
    const kind = choice.finish_reason === 'length' ? 'timeout' : 'error';
    throw new RelayError(kind, 200, `réponse illisible (finish_reason ${choice.finish_reason ?? '?'})`);
  }
  const u = raw.usage ?? {};
  return {
    value,
    usage: { prompt: u.prompt_tokens ?? 0, completion: u.completion_tokens ?? 0, reasoning: u.completion_tokens_details?.reasoning_tokens ?? 0 },
    model: raw.model ?? '',
  };
}

/** Maps an HTTP status to what it means for the review. */
export function failureOf(status: number): RelayFailure {
  if (status === 402) return 'credits';
  if (status === 401 || status === 403) return 'token';
  if (status === 429) return 'rate';
  // Lovable's hosting sits behind Cloudflare: 524 is its origin timeout, 522/504 the gateway's.
  if (status === 524 || status === 522 || status === 504) return 'timeout';
  return 'error';
}

export class LovableRelay implements Relay {
  readonly #url: string;
  readonly #token: string;
  readonly #caller: string;
  readonly #timeoutMs: number;

  constructor(url: string, token: string, caller: string, timeoutMs = CALL_TIMEOUT_MS) {
    this.#url = url.replace(/\/+$/, '');
    this.#token = token;
    this.#caller = caller;
    this.#timeoutMs = timeoutMs;
  }

  /** `text` without the relay's secrets — its token, its address, its host — should an answer echo them. */
  #redact(text: string): string {
    let host = '';
    try {
      host = new URL(this.#url).host;
    } catch {
      // Not a URL: the address itself is taken out.
    }
    return [this.#token, this.#url, host].filter((x) => x.length >= 3).reduce((t, x) => t.split(x).join('…'), text);
  }

  async json<T>(req: JsonRequest): Promise<JsonAnswer<T>> {
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${this.#url}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.#token}`, 'content-type': 'application/json', 'x-relay-caller': this.#caller },
          body: JSON.stringify(chatBody(req)),
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (err) {
        // Never the address in a message: it is a secret.
        const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        throw new RelayError(timeout ? 'timeout' : 'error', 0, timeout ? `pas de réponse en ${this.#timeoutMs / 1000} s` : 'connexion au relais impossible');
      }
      const wait = RATE_WAITS_MS[attempt];
      if (res.status === 429 && wait !== undefined) {
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        // What the relay said helps tell a refusal from an outage; its secrets are taken out before the
        // cut, as a secret cut in half escapes the logs' masking.
        const text = this.#redact(await res.text().catch(() => ''));
        throw new RelayError(failureOf(res.status), res.status, `relais ${res.status} ${text.replace(/\s+/g, ' ').slice(0, 120)}`.trim());
      }
      const raw = (await res.json().catch(() => null)) as RawAnswer | null;
      if (!raw) throw new RelayError('error', res.status, 'réponse non JSON');
      const answer = parseAnswer(raw);
      return { value: answer.value as T, usage: answer.usage, model: answer.model || req.model, ms: Date.now() - started };
    }
  }
}
