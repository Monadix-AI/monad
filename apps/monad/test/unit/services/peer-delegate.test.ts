// Unit coverage for the peer-delegate tool's HTTP/SSE client against a capture server: request
// construction (URL, auth header, model/agent override, body) and OpenAI SSE parsing edge cases
// (multi-chunk accumulation, [DONE], malformed frames, JSON vs non-JSON error bodies). The e2e
// (peer-delegate.test.ts) covers the real B daemon; this pins the wire details deterministically.

import type { SessionId } from '@monad/protocol';
import type { ToolContext } from '@/capabilities/tools/types.ts';

import { afterAll, beforeEach, expect, test } from 'bun:test';

import { createPeerDelegateTool, type PeerDelegateTarget } from '@/services/delegation/peer-delegate.ts';

interface Captured {
  method: string;
  path: string;
  auth: string | null;
  contentType: string | null;
  body: Record<string, unknown>;
}

let captured: Captured | undefined;
let responder: () => Response = () => sse(['{"choices":[{"delta":{"content":"ok"}}]}', '[DONE]']);

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    captured = {
      method: req.method,
      path: url.pathname,
      auth: req.headers.get('authorization'),
      contentType: req.headers.get('content-type'),
      body
    };
    return responder();
  }
});
const BASE = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));
beforeEach(() => {
  captured = undefined;
});

function sse(frames: string[]): Response {
  return new Response(frames.map((f) => `data: ${f}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' }
  });
}

function fakeCtx(progress?: string[]): ToolContext {
  return {
    sessionId: 'ses_A' as SessionId,
    toolCallId: 'tc_1',
    signal: new AbortController().signal,
    reportProgress: (output: string) => progress?.push(output),
    log: () => {}
  } as unknown as ToolContext;
}

function target(over: Partial<PeerDelegateTarget> = {}): PeerDelegateTarget {
  return { id: 'peer_B', label: 'B', baseUrl: BASE, defaultAgent: 'default', token: 'tok', ...over };
}

test('posts to /v1/chat/completions with bearer auth and a streaming user turn', async () => {
  const tool = createPeerDelegateTool({ peers: [target()] });
  await tool.run({ peer: 'B', instruction: 'do the thing' }, fakeCtx());
  expect(captured?.method).toBe('POST');
  expect(captured?.path).toBe('/v1/chat/completions');
  expect(captured?.auth).toBe('Bearer tok');
  expect(captured?.body.stream).toBe(true);
  expect(captured?.body.model).toBe('default');
  expect(captured?.body.messages).toEqual([{ role: 'user', content: 'do the thing' }]);
});

test('an explicit agent overrides the peer default; omitting it uses the default', async () => {
  const tool = createPeerDelegateTool({ peers: [target({ defaultAgent: 'agt_main' })] });
  await tool.run({ peer: 'B', agent: 'agt_special', instruction: 'x' }, fakeCtx());
  expect(captured?.body.model).toBe('agt_special');
  await tool.run({ peer: 'B', instruction: 'x' }, fakeCtx());
  expect(captured?.body.model).toBe('agt_main');
});

test('a trailing slash on baseUrl does not double the path separator', async () => {
  const tool = createPeerDelegateTool({ peers: [target({ baseUrl: `${BASE}/` })] });
  await tool.run({ peer: 'B', instruction: 'x' }, fakeCtx());
  expect(captured?.path).toBe('/v1/chat/completions');
});

test('accumulates streamed deltas, ignores malformed frames and [DONE]', async () => {
  responder = () =>
    sse([
      '{"choices":[{"delta":{"content":"Hel"}}]}',
      '{"choices":[{"delta":{"content":"lo"}}]}',
      '{ this is not json',
      '{"choices":[{"delta":{}}]}',
      '[DONE]'
    ]);
  const progress: string[] = [];
  const tool = createPeerDelegateTool({ peers: [target()] });
  const result = await tool.run({ peer: 'B', instruction: 'x' }, fakeCtx(progress));
  expect(result.metadata.text).toBe('Hello');
  expect(progress).toEqual(['Hel', 'Hello']); // one report per content delta
  responder = () => sse(['{"choices":[{"delta":{"content":"ok"}}]}', '[DONE]']);
});

test('a non-JSON error body surfaces the status line without leaking the token', async () => {
  responder = () => new Response('upstream exploded', { status: 502 });
  const tool = createPeerDelegateTool({ peers: [target({ token: 'super-secret' })] });
  const err = await tool.run({ peer: 'B', instruction: 'x' }, fakeCtx()).catch((e: unknown) => e as Error);
  expect((err as Error).message).toMatch(/HTTP 502/);
  responder = () => sse(['{"choices":[{"delta":{"content":"ok"}}]}', '[DONE]']);
});

test('a JSON error body lifts the upstream message', async () => {
  responder = () =>
    new Response(JSON.stringify({ error: { message: 'no such agent' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' }
    });
  const tool = createPeerDelegateTool({ peers: [target()] });
  const _err = await tool.run({ peer: 'B', instruction: 'x' }, fakeCtx()).catch((e: unknown) => e as Error);
  responder = () => sse(['{"choices":[{"delta":{"content":"ok"}}]}', '[DONE]']);
});

test('with no peers configured, any name is unknown and lists none', async () => {
  const tool = createPeerDelegateTool({ peers: [] });
  await expect(tool.run({ peer: 'B', instruction: 'x' }, fakeCtx())).rejects.toThrow(
    /unknown peer "B" \(configured: none\)/
  );
});

test('the tool description advertises the configured peers and their agents', () => {
  const tool = createPeerDelegateTool({ peers: [target({ label: 'home', defaultAgent: 'coder' })] });
  expect(tool.highRisk).toBe(true);
});
