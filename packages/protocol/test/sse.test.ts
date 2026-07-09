import { expect, test } from 'bun:test';

import { eventSchema } from '../src/domain.ts';
import {
  parseTypedSseFrame,
  readTypedSseStream,
  SSE_HEARTBEAT_MS,
  SSE_IDLE_TIMEOUT_MS,
  type SseByteReader
} from '../src/sse.ts';

test('SSE idle timeout stays well above the heartbeat interval', () => {
  // A healthy idle stream must receive at least two heartbeats before a client gives up, or the
  // client would false-reconnect every cycle. Preserve this invariant if either constant moves.
  expect(SSE_IDLE_TIMEOUT_MS).toBeGreaterThanOrEqual(2 * SSE_HEARTBEAT_MS);
});

const event = {
  id: 'evt_01ABC0000000',
  sessionId: 'ses_01ABC0000000',
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

test('parseTypedSseFrame: valid frame → event + id', () => {
  const r = parseTypedSseFrame(`id: evt_01ABC0000000\ndata: ${JSON.stringify(event)}`, eventSchema);
  expect(r.kind).toBe('event');
  expect(r.eventId).toBe('evt_01ABC0000000');
});

test('parseTypedSseFrame: heartbeat / [DONE] → empty', () => {
  expect(parseTypedSseFrame(': keep-alive', eventSchema).kind).toBe('empty');
  expect(parseTypedSseFrame('data: [DONE]', eventSchema).kind).toBe('empty');
});

test('parseTypedSseFrame: malformed JSON and schema-invalid → invalid (never throws)', () => {
  expect(parseTypedSseFrame('data: {not json', eventSchema).kind).toBe('invalid');
  expect(parseTypedSseFrame('data: {"id":"nope"}', eventSchema).kind).toBe('invalid');
});

test('readTypedSseStream: decodes events across chunk boundaries and returns last id', async () => {
  const seen: string[] = [];
  // split one frame mid-way to exercise the buffer across reads
  const full = frame(event, 'evt_01ABC0000000') + frame({ ...event, id: 'evt_02DEF0000000' }, 'evt_02DEF0000000');
  const mid = Math.floor(full.length / 2);
  const lastId = await readTypedSseStream(readerOf([full.slice(0, mid), full.slice(mid)]), eventSchema, (e) =>
    seen.push(e.id)
  );
  expect(seen).toEqual(['evt_01ABC0000000', 'evt_02DEF0000000']);
  expect(lastId).toBe('evt_02DEF0000000');
});

test('readTypedSseStream: invalid frames are dropped via onInvalid, valid ones still delivered', async () => {
  const seen: string[] = [];
  const invalids: string[] = [];
  const stream = `data: {bad\n\n${frame(event, 'evt_01ABC0000000')}`;
  await readTypedSseStream(readerOf([stream]), eventSchema, (e) => seen.push(e.id), {
    onInvalid: (err) => invalids.push(err)
  });
  expect(seen).toEqual(['evt_01ABC0000000']);
  expect(invalids.length).toBe(1);
});

test('readTypedSseStream: a throwing onEvent is isolated — later frames still delivered', async () => {
  const seen: string[] = [];
  const two = frame(event, 'evt_01ABC0000000') + frame({ ...event, id: 'evt_02DEF0000000' }, 'evt_02DEF0000000');
  await readTypedSseStream(readerOf([two]), eventSchema, (e) => {
    seen.push(e.id);
    if (e.id === 'evt_01ABC0000000') throw new Error('handler bug');
  });
  expect(seen).toEqual(['evt_01ABC0000000', 'evt_02DEF0000000']); // the throw did not abort the read
});

test('readTypedSseStream: onActivity fires on every read, including a heartbeat-only chunk', async () => {
  let activity = 0;
  await readTypedSseStream(readerOf([': keep-alive\n\n', frame(event, 'evt_01ABC0000000')]), eventSchema, () => {}, {
    onActivity: () => activity++
  });
  expect(activity).toBe(2); // one per chunk read (heartbeat chunk + event chunk)
});
