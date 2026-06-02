import { afterAll, beforeAll, expect, test } from 'bun:test';

import { connectMcpServer, type McpConnection } from '@/capabilities/tools';

// Exercises the http transport's text/event-stream (SSE) response path: every JSON-RPC
// response comes back as an SSE `event: message / data: {…}` frame rather than a plain
// application/json body. Verifies readSseResponse matches the response by id.
let server: ReturnType<typeof Bun.serve>;
let conn: McpConnection;

function sse(obj: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(obj)}\n\n`, {
    headers: { 'content-type': 'text/event-stream', ...extraHeaders }
  });
}

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
      const msg = (await req.json()) as { id?: number; method: string; params?: { arguments?: { text?: string } } };
      if (msg.method === 'notifications/initialized') return new Response(null, { status: 202 });

      let result: unknown;
      if (msg.method === 'initialize') {
        result = {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'mock-sse', version: '0.0.0' }
        };
        return sse({ jsonrpc: '2.0', id: msg.id, result }, { 'mcp-session-id': 'sse-sess' });
      }
      if (msg.method === 'tools/list') {
        result = { tools: [{ name: 'echo', description: 'echo text', inputSchema: { type: 'object' } }] };
      } else if (msg.method === 'tools/call') {
        result = { content: [{ type: 'text', text: msg.params?.arguments?.text ?? '' }], isError: false };
      } else {
        return sse({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
      }
      return sse({ jsonrpc: '2.0', id: msg.id, result });
    }
  });
  conn = await connectMcpServer({ name: 'sse', transport: 'http', url: `http://127.0.0.1:${server.port}/mcp` });
});

afterAll(async () => {
  await conn.close();
  server.stop(true);
});

test('http transport parses SSE responses during the handshake', () => {
  expect(conn.tools.map((t) => t.name)).toEqual(['sse__echo']);
});

test('http transport parses an SSE tools/call response', async () => {
  expect(await conn.callTool('echo', { text: 'streamed' })).toEqual([{ type: 'text', text: 'streamed' }]);
});
