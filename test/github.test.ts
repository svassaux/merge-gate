import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type Server } from 'node:net';
import { describe, it } from 'node:test';
import { GitHub, HttpError } from '../src/github.ts';

/** What a network failure looks like to fetch, at each point of a request. */
const failures: Record<string, () => Server> = {
  'the connection closed at once': () => createServer((socket) => socket.destroy()),
  // Headers and the start of a body, then nothing: `fetch` has resolved, the body read is what fails.
  'the body cut halfway': () =>
    createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
      res.write('{"a":');
      setTimeout(() => res.socket?.destroy(), 10);
    }),
};

describe('the GitHub client', () => {
  for (const [label, make] of Object.entries(failures)) {
    it(`reports GitHub out of reach as an outage (status 0), after its retries, not as a refusal: ${label}`, async () => {
      const server = make();
      let requests = 0;
      server.on('connection', () => requests++);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as { port: number };
      try {
        const gh = new GitHub('t', 'o', 'r', `http://127.0.0.1:${port}`, 1);
        await assert.rejects(gh.rest('GET', '/repos/o/r/pulls/1'), (e: unknown) => {
          assert.ok(e instanceof HttpError, String(e));
          assert.deepEqual([e.status, e.transient], [0, true]);
          return true;
        });
        assert.equal(requests, 3, 'each failure is tried three times');
      } finally {
        server.close();
      }
    });
  }
});
