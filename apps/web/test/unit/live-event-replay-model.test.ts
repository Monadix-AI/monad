import { expect, test } from 'bun:test';
import { agentObservationEventSchema } from '@monad/protocol';

import {
  formattedReplayPayload,
  historyReplayFrames,
  liveReplayFrames,
  replayProjection,
  replaySource,
  selectReplayOption
} from '#/features/developer/live-event-replay-model.ts';

test('replay route values preserve deep-link selections until options load', () => {
  expect({
    live: replaySource('live'),
    history: replaySource('history'),
    invalid: replaySource('snapshot'),
    pending: selectReplayOption('ses_requested', []),
    available: selectReplayOption('ses_requested', ['ses_other', 'ses_requested']),
    fallback: selectReplayOption('ses_missing', ['ses_first', 'ses_second'])
  }).toEqual({
    live: 'live',
    history: 'history',
    invalid: undefined,
    pending: 'ses_requested',
    available: 'ses_requested',
    fallback: 'ses_first'
  });
});

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

test('live replay derives OpenClaw reasoning duration from provider ts values', () => {
  const sessionKey = 'agent:main:subagent:monad-test';
  const frames = liveReplayFrames(
    [
      {
        seq: 4,
        stream: 'stdout',
        payload: `${JSON.stringify({
          type: 'event',
          event: 'agent',
          payload: {
            runId: 'run-1',
            stream: 'thinking',
            data: { text: 'The user is', delta: 'The user is' },
            sessionKey,
            ts: 1787109835000
          }
        })}\n`,
        observedAt: '2026-08-19T03:23:55.100Z'
      },
      {
        seq: 5,
        stream: 'stdout',
        payload: `${JSON.stringify({
          type: 'event',
          event: 'agent',
          payload: {
            runId: 'run-1',
            stream: 'thinking',
            data: { text: 'The user is telling', delta: ' telling' },
            sessionKey,
            ts: 1787109835694
          }
        })}\n`,
        observedAt: '2026-08-19T03:23:55.800Z'
      }
    ],
    'oep_100000000001'
  );

  const projection = replayProjection({
    frames,
    meshSessionId: 'mesh_100000000001',
    provider: 'openclaw',
    source: 'live'
  });

  expect(
    projection.events.map((event) => ({
      kind: event.kind,
      text: event.text,
      streaming: event.streaming,
      at: event.at,
      durationMs: event.durationMs
    }))
  ).toEqual([
    {
      kind: 'reasoning',
      text: 'The user is telling',
      streaming: true,
      at: '2026-08-19T03:23:55.000Z',
      durationMs: 694
    }
  ]);
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

test('history replay folds matching tool frames and derives their duration from native timestamps', () => {
  const frames = historyReplayFrames({
    records: [
      {
        providerIdentity: '00413aa5',
        data: {
          type: 'message',
          id: '00413aa5',
          timestamp: '2026-08-19T03:24:03.489Z',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'toolCall',
                id: 'call-e70cedc2-5ce4-4eaa-a199-c5376a09349f',
                name: 'monad__project_post',
                arguments: { text: 'Ready to help.' }
              }
            ]
          }
        }
      },
      {
        providerIdentity: '0e3396cc',
        data: {
          type: 'message',
          id: '0e3396cc',
          timestamp: '2026-08-19T03:24:03.552Z',
          message: {
            role: 'toolResult',
            toolCallId: 'call-e70cedc2-5ce4-4eaa-a199-c5376a09349f',
            toolName: 'monad__project_post',
            content: [{ type: 'text', text: '{"ok":true}' }],
            isError: false
          }
        }
      }
    ],
    coverage: 'settled'
  });

  const projection = replayProjection({
    frames,
    meshSessionId: 'mesh_zzBj03XDMZw8',
    provider: 'openclaw',
    source: 'history'
  });

  expect(
    projection.cards.map((card) => {
      const result = agentObservationEventSchema.safeParse(card.payload.result);
      return {
        kind: card.kind,
        streaming: card.streaming,
        at: card.at,
        durationMs: result.success ? result.data.tool?.durationMs : undefined
      };
    })
  ).toEqual([
    {
      kind: 'tool',
      streaming: false,
      at: '2026-08-19T03:24:03.552Z',
      durationMs: 63
    }
  ]);
});
