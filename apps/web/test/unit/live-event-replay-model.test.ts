import { expect, test } from 'bun:test';

import {
  formattedReplayPayload,
  historyReplayFrames,
  liveReplayFrames,
  replayProjection
} from '#/features/developer/live-event-replay-model.ts';

test('live replay preserves packet boundaries while projecting provider records', () => {
  const frames = liveReplayFrames(
    [
      {
        seq: 1,
        stream: 'stdout',
        payload: '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}\n',
        observedAt: '2026-08-11T00:00:00.000Z'
      },
      { seq: 2, stream: 'stderr', payload: 'warning', observedAt: '2026-08-11T00:00:00.010Z' }
    ],
    'oep_100000000001'
  );
  const projection = replayProjection({
    frames,
    meshSessionId: 'mesh_100000000001',
    provider: 'claude-code',
    source: 'live'
  });

  expect({ frames, eventTexts: projection.events.map((event) => event.text) }).toEqual({
    frames: [
      {
        identity: 'live:oep_100000000001:1',
        seq: 1,
        stream: 'stdout',
        payload: '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}\n',
        observedAt: '2026-08-11T00:00:00.000Z'
      },
      {
        identity: 'live:oep_100000000001:2',
        seq: 2,
        stream: 'stderr',
        payload: 'warning',
        observedAt: '2026-08-11T00:00:00.010Z'
      }
    ],
    eventTexts: ['hello']
  });
});

test('history replay keeps native records and formats the selected raw frame', () => {
  const frames = historyReplayFrames({
    records: [
      { providerIdentity: 'turn-1', data: { type: 'message', text: 'hello' }, observedAt: '2026-08-11T00:00:00.000Z' }
    ],
    coverage: 'settled'
  });

  expect({ frames, formatted: formattedReplayPayload(frames[0]?.payload) }).toEqual({
    frames: [
      {
        identity: 'turn-1',
        seq: 'turn-1',
        payload: { type: 'message', text: 'hello' },
        observedAt: '2026-08-11T00:00:00.000Z'
      }
    ],
    formatted: '{\n  "type": "message",\n  "text": "hello"\n}'
  });
});
