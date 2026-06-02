import { expect, test } from 'bun:test';

import { parseSseFrame, readSseStream, type SseByteReader } from '../src/sse.ts';

const event = {
  id: 'evt_01ABC',
  sessionId: 'ses_01ABC',
  type: 'session.updated',
  actorAgentId: null,
  payload: {},
  at: '2026-01-01T00:00:00.000Z'
};

function frame(ev: unknown, id?: string): string {
  return `${id ? `id: ${id}\n` : ''}event: ${(ev as { type: string }).type}\ndata: ${JSON.stringify(ev)}\n\n`;
}

/** A byte reader that emits the given string chunks once, then signals done. */
function readerOf(chunks: string[]): SseByteReader {
  const enc = new TextEncoder();
  let i = 0;
  return {
    read: () => Promise.resolve(i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true })
  };
}

test('parseSseFrame: valid frame → event + id', () => {
  const r = parseSseFrame(`id: evt_01ABC\ndata: ${JSON.stringify(event)}`);
  expect(r.kind).toBe('event');
  expect(r.eventId).toBe('evt_01ABC');
});

test('parseSseFrame: heartbeat / [DONE] → empty', () => {
  expect(parseSseFrame(': keep-alive').kind).toBe('empty');
  expect(parseSseFrame('data: [DONE]').kind).toBe('empty');
});

test('parseSseFrame: malformed JSON and schema-invalid → invalid (never throws)', () => {
  expect(parseSseFrame('data: {not json').kind).toBe('invalid');
  expect(parseSseFrame('data: {"id":"nope"}').kind).toBe('invalid');
});

test('readSseStream: decodes events across chunk boundaries and returns last id', async () => {
  const seen: string[] = [];
  // split one frame mid-way to exercise the buffer across reads
  const full = frame(event, 'evt_01ABC') + frame({ ...event, id: 'evt_02DEF' }, 'evt_02DEF');
  const mid = Math.floor(full.length / 2);
  const lastId = await readSseStream(readerOf([full.slice(0, mid), full.slice(mid)]), (e) => seen.push(e.id));
  expect(seen).toEqual(['evt_01ABC', 'evt_02DEF']);
  expect(lastId).toBe('evt_02DEF');
});

test('readSseStream: invalid frames are dropped via onInvalid, valid ones still delivered', async () => {
  const seen: string[] = [];
  const invalids: string[] = [];
  const stream = `data: {bad\n\n${frame(event, 'evt_01ABC')}`;
  await readSseStream(readerOf([stream]), (e) => seen.push(e.id), { onInvalid: (err) => invalids.push(err) });
  expect(seen).toEqual(['evt_01ABC']);
  expect(invalids.length).toBe(1);
});
