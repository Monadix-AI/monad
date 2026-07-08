// e2e: the daemon serves its full HTTP surface over a Unix domain socket, the
// low-latency local path the CLI uses. We mount the same Elysia app on a unix
// socket exactly as main.ts does, then drive it with Bun's `fetch({ unix })`.
// Also asserts the remote-access guard trusts unix-origin requests (no peer IP →
// local, no bearer token required).

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHttpTransport } from '#/transports/http.ts';
import { buildHandlers, mockModel } from '../helpers.ts';

type UnixServer = { stop: (force?: boolean) => void };

let sock: string;
let server: UnixServer;

function serveUnix(app: { handle: (req: Request) => Promise<Response> }, path: string): UnixServer {
  return Bun.serve({ unix: path, fetch: (req) => app.handle(req) }) as unknown as UnixServer;
}

beforeEach(() => {
  // Keep the path short — macOS caps unix socket paths around 104 bytes.
  sock = join(tmpdir(), `monad-ut-${process.pid}-${Date.now()}.sock`);
});

afterEach(async () => {
  server.stop(true);
  await unlink(sock).catch(() => {});
});

test('health and a /v1 route are reachable over the unix socket', async () => {
  const app = createHttpTransport(buildHandlers(mockModel()));
  server = serveUnix(app, sock);

  // Host is irrelevant when `unix` is set — it only forms the path + Host header.
  const health = await fetch('http://localhost/health', { unix: sock });
  expect(health.status).toBe(200);

  const created = await fetch('http://localhost/v1/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'over-unix' }),
    unix: sock
  });
  expect(created.status).toBe(201);
  expect(await created.json()).toHaveProperty('sessionId');
});

test('remote-access guard trusts unix-origin requests without a token', async () => {
  const app = createHttpTransport(buildHandlers(mockModel()), {
    remoteAccess: { enabled: true, token: 'secret-token' }
  });
  server = serveUnix(app, sock);

  // No Authorization header — over the unix socket there is no peer IP, so the
  // guard treats the request as local and lets a real /v1 op through.
  const res = await fetch('http://localhost/v1/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'no-token' }),
    unix: sock
  });
  expect(res.status).toBe(201);
});
