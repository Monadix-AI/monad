// Streamable HTTP: POST /messages with Accept: text/event-stream streams this turn's
// events back inline on the POST response (single round-trip = send + receive).

import type { Event } from '@monad/protocol';

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { parseEventPayload } from '@monad/protocol';

import { listen, mockModel } from '../helpers.ts';

let server: { base: string; stop: () => void };

beforeAll(() => {
  server = listen(mockModel(['Hel', 'lo', '!'], 5));
});
afterAll(() => server.stop());

async function createSession(): Promise<string> {
  const res = await fetch(`${server.base}/v1/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'streamable' })
  });
  return ((await res.json()) as { sessionId: string }).sessionId;
}

test('POST /messages with Accept: text/event-stream streams the round inline then closes', async () => {
  const sessionId = await createSession();
  const res = await fetch(`${server.base}/v1/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ text: 'hi' })
  });

  expect(res.headers.get('content-type')).toContain('text/event-stream');

  const reader = res.body?.getReader();
  if (!reader) throw new Error('no response body');
  const decoder = new TextDecoder();
  const events: Event[] = [];
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break; // stream closed by server when the round completed
    buf += decoder.decode(value, { stream: true });
    let sep = buf.indexOf('\n\n');
    while (sep !== -1) {
      const dataLine = buf
        .slice(0, sep)
        .split('\n')
        .find((l) => l.startsWith('data: '));
      if (dataLine) events.push(JSON.parse(dataLine.slice(6)) as Event);
      buf = buf.slice(sep + 2);
      sep = buf.indexOf('\n\n');
    }
  }

  const tokens = events.filter((e) => e.type === 'session.message.delta.appended');
  const finals = events.filter((e) => e.type === 'session.message.completed');
  expect(tokens.length).toBe(3);
  expect(finals.length).toBe(1);
  const final = finals[0];
  if (!final) throw new Error('missing completed message');
  expect(parseEventPayload('session.message.completed', final.payload).message.text).toBe('Hello!');
});

test('fire-and-forget POST /messages (no Accept) returns {accepted:true}', async () => {
  const sessionId = await createSession();
  const res = await fetch(`${server.base}/v1/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hi' })
  });
  expect(await res.json()).toEqual({ accepted: true });
});
