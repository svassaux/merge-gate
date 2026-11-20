import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { FINDINGS_SCHEMA } from '../src/prompts.ts';
import { chatBody, failureOf, LovableRelay, parseAnswer, RelayError } from '../src/relay.ts';

/** The relay's real answers to the review's request, recorded on 2026-11-19: GPT in its content, Gemini in a forced call. */
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Parameters<typeof parseAnswer>[0];

const request = (model: string) => ({ model, effort: 'high' as const, system: 's', user: 'u', schema: FINDINGS_SCHEMA });

describe('the relay’s answer', () => {
  it('reads the finding out of each family’s real answer', () => {
    for (const name of ['relay-gpt-json', 'relay-gemini-tool']) {
      const a = parseAnswer(fixture(name));
      const findings = (a.value as { findings: { path: string; line: number; severity: string }[] }).findings;
      assert.equal(findings.length, 1, name);
      assert.deepEqual([findings[0]?.path, findings[0]?.line], ['src/sum.ts', 3], name);
      assert.ok(a.usage.prompt > 0 && a.usage.completion > 0, name);
      assert.ok(a.model, name);
    }
  });

  it('asks GPT for a JSON answer and Gemini for a forced call — GPT refuses a forced call while it reasons', () => {
    const gpt = chatBody(request('openai/gpt-6.1-terra'));
    assert.deepEqual(Object.keys(gpt).sort(), ['messages', 'model', 'reasoning_effort', 'response_format']);
    const gemini = chatBody(request('google/gemini-4-argon'));
    assert.deepEqual(Object.keys(gemini).sort(), ['messages', 'model', 'reasoning_effort', 'tool_choice', 'tools']);
    assert.ok(!('reasoning_effort' in chatBody({ ...request('google/gemini-4-argon'), effort: null })));
  });

  it('unwraps a fenced answer, and tells a model that ran out of room from one that answered nonsense', () => {
    const answer = (content: string, finish = 'stop') => ({ choices: [{ finish_reason: finish, message: { content } }] });
    assert.deepEqual(parseAnswer(answer('```json\n{"findings":[]}\n```')).value, { findings: [] });
    assert.throws(() => parseAnswer(answer('', 'length')), (e: RelayError) => e.kind === 'timeout');
    assert.throws(() => parseAnswer(answer('I found nothing.')), (e: RelayError) => e.kind === 'error');
    assert.throws(() => parseAnswer({ choices: [{ message: { refusal: 'no' } }] }), (e: RelayError) => e.kind === 'error');
  });

  it('maps each status to what it means for the review', () => {
    assert.deepEqual(
      [402, 401, 403, 429, 524, 522, 504, 500, 400].map(failureOf),
      ['credits', 'token', 'token', 'rate', 'timeout', 'timeout', 'timeout', 'error', 'error'],
    );
  });
});

describe('the relay client, over a real connection', () => {
  // The address carries a secret-looking path: no message may repeat it, the run logs are public.
  let server: Server;
  let url = '';
  const seen: { caller?: string; auth?: string; body?: Record<string, unknown> }[] = [];
  let answer: (res: import('node:http').ServerResponse) => void = () => undefined;

  before(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        seen.push({ caller: req.headers['x-relay-caller'] as string, auth: req.headers.authorization, body: JSON.parse(raw) as Record<string, unknown> });
        answer(res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/secret-path-0123/relay/v1/`;
  });
  after(() => server.close());

  it('sends the token and its caller’s name, and returns the parsed answer', async () => {
    answer = (res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(fixture('relay-gpt-json')));
    const a = await new LovableRelay(url, 'tok', 'merge-gate:demo').json<{ findings: unknown[] }>(request('openai/gpt-6.1-terra'));
    assert.equal(a.value.findings.length, 1);
    assert.deepEqual([seen.at(-1)?.caller, seen.at(-1)?.auth, seen.at(-1)?.body?.['model']], ['merge-gate:demo', 'Bearer tok', 'openai/gpt-6.1-terra']);
  });

  it('says no credit on 402 and a timeout on 524, without the address', async () => {
    for (const [status, kind] of [
      [402, 'credits'],
      [524, 'timeout'],
    ] as const) {
      answer = (res) => res.writeHead(status).end('upstream says no');
      await assert.rejects(new LovableRelay(url, 'tok', 'c').json(request('openai/gpt-6.1-terra')), (e: RelayError) => {
        assert.equal(e.kind, kind);
        assert.doesNotMatch(e.message, /secret-path|127\.0\.0\.1/);
        return true;
      });
    }
  });

  it('keeps what an error answer says, without the token, the address or the host it may echo', async () => {
    const token = 'tok-0123456789abcdef';
    answer = (res) => res.writeHead(500).end(`bad bearer ${token} for ${url} at ${new URL(url).host}: try later`);
    await assert.rejects(new LovableRelay(url, token, 'c').json(request('openai/gpt-6.1-terra')), (e: RelayError) => {
      assert.equal(e.kind, 'error');
      assert.match(e.message, /^relais 500 bad bearer … for …/);
      assert.doesNotMatch(e.message, /tok-0123|secret-path|127\.0\.0\.1/);
      return true;
    });
  });

  it('gives up on a relay that does not answer, as a timeout', async () => {
    answer = () => undefined; // never answers
    await assert.rejects(new LovableRelay(url, 'tok', 'c', 300).json(request('openai/gpt-6.1-terra')), (e: RelayError) => {
      assert.equal(e.kind, 'timeout');
      assert.doesNotMatch(e.message, /secret-path|127\.0\.0\.1/);
      return true;
    });
    server.closeAllConnections();
  });
});
