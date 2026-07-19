// Observation Task 5: the raw plane's display model. The raw view lists exact provider frames — one
// row per MeshRawEvent, keyed by its resume cursor, with the stream channel and a bounded
// payload preview. Pure formatting so the panel's raw mode renders without re-deriving from bytes.

import type { MeshRawEvent } from '@monad/protocol';

import { expect, test } from 'bun:test';

import {
  rawDisplayEntries,
  rawFrameRow,
  rawFrameRows
} from '../../src/workspace-experiences/chat-room/components/observation/raw-view.ts';

test('line mode renders one entry per physical line', () => {
  expect(rawDisplayEntries('first\nsecond\n', 'lines')).toEqual(['first', 'second']);
});

test('parsed mode pretty-prints JSONL and falls back to verbatim text', () => {
  expect(rawDisplayEntries('{"a":1}\n{"b":2}\n', 'parsed')).toEqual(['{\n  "a": 1\n}', '{\n  "b": 2\n}']);
  expect(rawDisplayEntries('not json', 'parsed')).toEqual(['not json']);
});

function frame(seq: number, stream: MeshRawEvent['stream'], data: unknown): MeshRawEvent {
  return {
    meshSessionId: 'mesh_000000000001',
    provider: 'codex',
    observationEpoch: 'e1',
    origin: 'live',
    cursor: `live:e1:${seq}`,
    stream,
    data,
    observedAt: '2026-07-18T00:00:00.000Z'
  };
}

test('a string payload renders verbatim as the preview', () => {
  expect(rawFrameRow(frame(1, 'stdout', 'hello world\n'))).toEqual({
    identity: 'live:e1:1',
    cursor: 'live:e1:1',
    stream: 'stdout',
    preview: 'hello world\n'
  });
});

test('a structured payload is serialized to compact JSON for the preview', () => {
  expect(rawFrameRow(frame(2, 'stdout', { type: 'item', uuid: 'u1' }))).toEqual({
    identity: 'live:e1:2',
    cursor: 'live:e1:2',
    stream: 'stdout',
    preview: '{"type":"item","uuid":"u1"}'
  });
});

test('a missing stream channel falls back to a neutral label', () => {
  const noStream: MeshRawEvent = {
    meshSessionId: 'mesh_000000000001',
    provider: 'codex',
    origin: 'events',
    cursor: 'live:e1:3',
    data: 'x'
  };
  expect(rawFrameRow(noStream).stream).toBe('unknown');
});

test('rawFrameRows preserves order and keys each row by cursor', () => {
  const rows = rawFrameRows([frame(1, 'stdout', 'a'), frame(2, 'stderr', 'b')]);
  expect(rows.map((r) => r.cursor)).toEqual(['live:e1:1', 'live:e1:2']);
  expect(rows.map((r) => r.stream)).toEqual(['stdout', 'stderr']);
});
