import { afterAll, beforeAll, expect, test } from 'bun:test';

import { connectMcpServer, type McpConnection } from '@/capabilities/tools';

// A minimal streamable-HTTP MCP server (application/json responses) to exercise the http
// transport: initialize → initialized(202) → tools/list → tools/call, plus auth header.
let server: ReturnType<typeof Bun.serve>;
let conn: McpConnection;
let lastAuth: string | null = null;
let lastSession: string | null = null;

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
      lastAuth = req.headers.get('authorization');
      lastSession = req.headers.get('mcp-session-id');
      const msg = (await req.json()) as { id?: number; method: string; params?: { arguments?: { text?: string } } };
      if (msg.method === 'notifications/initialized') return new Response(null, { status: 202 });

      let result: unknown;
      if (msg.method === 'initialize') {
        result = {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'mock-http', version: '0.0.0' }
        };
      } else if (msg.method === 'tools/list') {
        result = { tools: [{ name: 'echo', description: 'echo text', inputSchema: { type: 'object' } }] };
      } else if (msg.method === 'tools/call') {
        result = { content: [{ type: 'text', text: msg.params?.arguments?.text ?? '' }], isError: false };
      } else {
        return Response.json({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
      }
      return Response.json({ jsonrpc: '2.0', id: msg.id, result }, { headers: { 'mcp-session-id': 'sess-1' } });
    }
  });
  conn = await connectMcpServer({
    name: 'remote',
    transport: 'http',
    url: `http://127.0.0.1:${server.port}/mcp`,
    headers: { authorization: 'Bearer xyz' }
  });
});

afterAll(async () => {
  await conn.close();
  server.stop(true);
});

test('http transport discovers and namespaces remote tools', () => {
  expect(conn.tools.map((t) => t.name)).toEqual(['remote__echo']);
});

test('http transport forwards the Authorization header', () => {
  expect(lastAuth).toBe('Bearer xyz');
});

test('http transport reuses the server-assigned session id', () => {
  // By the time tools/list ran, the initialize response had set Mcp-Session-Id.
  expect(lastSession).toBe('sess-1');
});

test('http transport round-trips tools/call', async () => {
  const out = await conn.callTool('echo', { text: 'hi' });
  expect(out).toEqual([{ type: 'text', text: 'hi' }]);
});
