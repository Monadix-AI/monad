import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHttpTransport } from '#/transports/http.ts';
import { buildHandlers, mockModel } from '../../helpers.ts';

// AGENTS.md: every daemon feature must behave identically over BOTH local transports — TCP loopback
// and the Unix-domain socket. The CLI's new commands (status, doctor, session new/list, commands)
// all reach the daemon over whichever transport the client dials, so we bind one app to both and
// assert the endpoints those commands hit return the same thing on each.

const app = createHttpTransport(buildHandlers(mockModel(['hello'])));
const handler = (req: Request) => app.handle(req);
const sockPath = join(tmpdir(), `monad-transport-${process.pid}.sock`);
const EXTERNAL_DEPENDENCY_ROUTES = new Set([
  '/v1/skills/search',
  '/v1/settings/mcp-servers/catalog',
  '/v1/settings/mcp-servers/registry/search'
]);

let tcp: ReturnType<typeof Bun.serve>;
let uds: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  tcp = Bun.serve({ port: 0, fetch: handler });
  uds = Bun.serve({ unix: sockPath, fetch: handler });
});

afterAll(() => {
  tcp.stop(true);
  uds.stop(true);
});

/** Fetch a path over TCP loopback and over the Unix socket; return both JSON bodies + statuses. */
async function bothTransports(path: string, init?: RequestInit) {
  const viaTcp = await fetch(`http://127.0.0.1:${tcp.port}${path}`, init);
  const viaUds = await fetch(`http://localhost${path}`, { ...init, unix: sockPath });
  return {
    tcp: { status: viaTcp.status, body: await viaTcp.json() },
    uds: { status: viaUds.status, body: await viaUds.json() }
  };
}

/** Every no-param GET route the live app mounts — these are read-only and must behave identically
 *  on both transports. Parametrised routes (`:id`) need a fixture, covered separately below. */
function readRoutes(): string[] {
  const mounted = app as unknown as { routes: { method: string; path: string }[] };
  return mounted.routes
    .filter((r) => r.method === 'GET' && !r.path.includes(':'))
    .filter((r) => !EXTERNAL_DEPENDENCY_ROUTES.has(r.path))
    .map((r) => r.path)
    .sort();
}

describe('transport parity (TCP loopback ⇆ Unix socket)', () => {
  // Breadth: every read endpoint returns the SAME status + body over both transports. Binding one
  // app to both sockets means any divergence is a transport-layer bug, not a handler difference.
  for (const path of readRoutes()) {
    test(`GET ${path} is identical on both transports`, async () => {
      const { tcp: t, uds: u } = await bothTransports(path);
      expect(u.status, `${path} status`).toBe(t.status);
      expect(u.body, `${path} body`).toEqual(t.body);
    });
  }

  test('GET /health (status / doctor) matches on both transports', async () => {
    const { tcp: t, uds: u } = await bothTransports('/health');
    expect(t.status).toBe(200);
    expect(u.status).toBe(200);
    expect(t.body).toMatchObject({ status: 'ok' });
    expect(u.body).toEqual(t.body);
  });

  test('GET /v1/commands (monad commands) matches on both transports', async () => {
    const { tcp: t, uds: u } = await bothTransports('/v1/commands');
    expect(t.status).toBe(200);
    expect(u.status).toBe(200);
    expect(u.body).toEqual(t.body);
  });

  test('POST /v1/sessions (session new) works over both, returning a ses_ id', async () => {
    const post = (title: string): RequestInit => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title })
    });
    const { tcp: t } = await bothTransports('/v1/sessions', post('over-tcp'));
    const { uds: u } = await bothTransports('/v1/sessions', post('over-uds'));
    expect((t.body as { sessionId: string }).sessionId).toMatch(/^ses_/);
    expect((u.body as { sessionId: string }).sessionId).toMatch(/^ses_/);
  });

  test('GET /v1/sessions (session list) matches shape on both transports', async () => {
    const { tcp: t, uds: u } = await bothTransports('/v1/sessions');
    expect(t.status).toBe(200);
    expect(u.status).toBe(200);
    expect(Array.isArray((t.body as { sessions: unknown[] }).sessions)).toBe(true);
    expect(Array.isArray((u.body as { sessions: unknown[] }).sessions)).toBe(true);
  });
});
