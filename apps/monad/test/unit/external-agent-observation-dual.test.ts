// Observation Task 3: the host-side transforms that turn ephemeral live-raw-store rows into the raw
// plane's ExternalAgentRawFrame and the convenience plane's incremental frames. Pure functions so the
// resolver/routes and their tests share one mapping. See the observation dual-stream plan Task 3.

import type { AgentObservationEvent } from '@monad/protocol';
import type { LiveRawRow } from '#/services/external-agent/live-raw-store.ts';

import { expect, test } from 'bun:test';

import {
  convenienceFramesFromEvents,
  liveRowsToRawFrames,
  readyFrame
} from '#/services/external-agent/host/observation-dual.ts';

const CTX = {
  externalAgentSessionId: 'exa_000000000001' as const,
  provider: 'codex',
  observationEpoch: 'epoch-1'
};

const rows: LiveRawRow[] = [
  { seq: 1, stream: 'app-server', payload: '{"type":"item","uuid":"a"}', observedAt: '2026-07-18T00:00:01.000Z' },
  { seq: 2, stream: 'stdout', payload: 'plain bytes\n', observedAt: '2026-07-18T00:00:02.000Z' }
];

test('liveRowsToRawFrames maps each row to a verbatim raw frame keyed by seq', () => {
  expect(liveRowsToRawFrames(CTX, rows)).toEqual([
    {
      externalAgentSessionId: 'exa_000000000001',
      provider: 'codex',
      observationEpoch: 'epoch-1',
      origin: 'live',
      cursor: '1',
      stream: 'app-server',
      data: '{"type":"item","uuid":"a"}',
      observedAt: '2026-07-18T00:00:01.000Z'
    },
    {
      externalAgentSessionId: 'exa_000000000001',
      provider: 'codex',
      observationEpoch: 'epoch-1',
      origin: 'live',
      cursor: '2',
      stream: 'stdout',
      data: 'plain bytes\n',
      observedAt: '2026-07-18T00:00:02.000Z'
    }
  ]);
});

const event: AgentObservationEvent = {
  id: 'ev-1',
  kind: 'assistant-message',
  streaming: false,
  text: 'hi',
  provenance: { contractEvents: [{ uuid: 'a' }] }
};

test('convenienceFramesFromEvents emits one upsert per event with a stable cursor', () => {
  expect(convenienceFramesFromEvents([event], (e) => `c:${e.id}`)).toEqual([
    { kind: 'upsert', cursor: 'c:ev-1', event }
  ]);
});

test('convenienceFramesFromEvents defaults the cursor to the event id', () => {
  expect(convenienceFramesFromEvents([event])).toEqual([{ kind: 'upsert', cursor: 'ev-1', event }]);
});

test('readyFrame carries the epoch and history boundary when present', () => {
  expect(readyFrame('epoch-1', '7')).toEqual({ kind: 'ready', observationEpoch: 'epoch-1', historyBefore: '7' });
  expect(readyFrame()).toEqual({ kind: 'ready' });
});
