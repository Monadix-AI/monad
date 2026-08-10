import type { Event } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { createJsonSseParser, readSSE } from '../sse.ts';

test('standard SSE parsing survives chunk boundaries, CRLF, comments, and multi-line JSON data', () => {
  const events: Event[] = [];
  const parser = createJsonSseParser((event) => events.push(event));

  parser.feed(': heartbeat\r\ndata: {"type":\r\n');
  parser.feed('data: "session.created","payload":{"sessionId":"ses_test"}}\r\n\r\n');
  parser.feed('event: message\nid: evt_2\ndata:{"type":"session.updated","payload":{}}\n\n');

  expect(events.map(({ type, payload }) => ({ type, payload }))).toEqual([
    { type: 'session.created', payload: { sessionId: 'ses_test' } },
    { type: 'session.updated', payload: {} }
  ]);
});

test('malformed Monad JSON events fail loudly instead of being swallowed as a timeout', () => {
  const parser = createJsonSseParser(() => {});

  expect(() => parser.feed('data: {not-json}\n\n')).toThrow();
});

test('readSSE stops synchronously at the matching frame within a multi-event network chunk', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        ['data: {"type":"session.created","payload":{}}\n\n', 'data: {"type":"session.updated","payload":{}}\n\n'].join(
          ''
        ),
        { headers: { 'content-type': 'text/event-stream' } }
      )
  });
  try {
    const events = await readSSE(`http://127.0.0.1:${server.port}`, {
      until: (event) => event.type === 'session.created'
    });

    expect(events.map(({ type, payload }) => ({ type, payload }))).toEqual([{ type: 'session.created', payload: {} }]);
  } finally {
    server.stop(true);
  }
});
