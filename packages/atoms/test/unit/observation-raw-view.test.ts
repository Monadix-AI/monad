// Observation Task 5: the raw plane's display model. The raw view lists exact provider frames — one
// row per ExternalAgentRawFrame, keyed by its resume cursor, with the stream channel and a bounded
// payload preview. Pure formatting so the panel's raw mode renders without re-deriving from bytes.

import type { ExternalAgentRawFrame } from '@monad/protocol';

import { expect, test } from 'bun:test';

import {
  rawFrameRow,
  rawFrameRows
} from '../../src/workspace-experiences/chat-room/components/observation/raw-view.ts';

function frame(seq: string, stream: ExternalAgentRawFrame['stream'], data: unknown): ExternalAgentRawFrame {
  return {
    externalAgentSessionId: 'exa_000000000001',
    provider: 'codex',
    observationEpoch: 'e1',
    origin: 'live',
    cursor: seq,
    stream,
    data,
    observedAt: '2026-07-18T00:00:00.000Z'
  };
}

test('a string payload renders verbatim as the preview', () => {
  expect(rawFrameRow(frame('1', 'stdout', 'hello world\n'))).toEqual({
    cursor: '1',
    stream: 'stdout',
    preview: 'hello world\n'
  });
});

test('a structured payload is serialized to compact JSON for the preview', () => {
  expect(rawFrameRow(frame('2', 'app-server', { type: 'item', uuid: 'u1' }))).toEqual({
    cursor: '2',
    stream: 'app-server',
    preview: '{"type":"item","uuid":"u1"}'
  });
});

test('a missing stream channel falls back to a neutral label', () => {
  const noStream: ExternalAgentRawFrame = {
    externalAgentSessionId: 'exa_000000000001',
    provider: 'codex',
    origin: 'history',
    cursor: '3',
    data: 'x'
  };
  expect(rawFrameRow(noStream).stream).toBe('unknown');
});

test('rawFrameRows preserves order and keys each row by cursor', () => {
  const rows = rawFrameRows([frame('1', 'stdout', 'a'), frame('2', 'stderr', 'b')]);
  expect(rows.map((r) => r.cursor)).toEqual(['1', '2']);
  expect(rows.map((r) => r.stream)).toEqual(['stdout', 'stderr']);
});
