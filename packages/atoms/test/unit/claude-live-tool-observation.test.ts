import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { builtinAgentAdapters } from '../../src/agent-adapters/index.ts';
import { agentObservationCards } from '../../src/workplace-experiences/chat-room/components/observation/card-projection.ts';
import { monadMcpToolView } from '../../src/workplace-experiences/chat-room/components/observation/monad-mcp-projection.ts';
import {
  ObservationTimelineRowView,
  observationTimelineEntries,
  observationTimelineRows
} from '../../src/workplace-experiences/chat-room/components/observation/timeline.tsx';
import { meshAgentNeutralStreamItems } from '../../src/workplace-experiences/experience/mesh-agent-observation/mesh-agent-observation.ts';

test('Claude live tool argument deltas settle into one canonical tool card', () => {
  const adapter = builtinAgentAdapters.find((candidate) => candidate.provider === 'claude-code');
  if (!adapter) throw new Error('claude-code adapter is unavailable');

  const callId = 'toolu_live_1';
  const uuid = 'assistant_live_1';
  const input = { file_path: '/tmp/example.ts' };
  const records = [
    {
      type: 'stream_event',
      uuid: 'message_start_live_1',
      session_id: 'session_live_1',
      event: { type: 'message_start', message: { id: uuid, role: 'assistant', content: [] } }
    },
    {
      type: 'assistant',
      uuid: 'thinking_live_1',
      session_id: 'session_live_1',
      message: {
        id: uuid,
        role: 'assistant',
        stop_reason: null,
        content: [{ type: 'thinking', thinking: '', signature: 'signature' }]
      }
    },
    {
      type: 'stream_event',
      uuid: 'tool_start_live_1',
      session_id: 'session_live_1',
      event: {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: callId, name: 'Read', input: {} }
      }
    },
    {
      type: 'stream_event',
      uuid: 'tool_delta_live_1_a',
      session_id: 'session_live_1',
      event: {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"file_path":"/tmp/exam' }
      }
    },
    {
      type: 'stream_event',
      uuid: 'tool_delta_live_1_b',
      session_id: 'session_live_1',
      event: {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: 'ple.ts"}' }
      }
    },
    {
      type: 'assistant',
      uuid,
      session_id: 'session_live_1',
      message: {
        id: uuid,
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: callId, name: 'Read', input }]
      }
    },
    {
      type: 'stream_event',
      uuid: 'tool_stop_live_1',
      session_id: 'session_live_1',
      event: { type: 'content_block_stop', index: 1 }
    },
    {
      type: 'stream_event',
      uuid: 'message_stop_live_1',
      session_id: 'session_live_1',
      event: { type: 'message_stop' }
    },
    {
      type: 'user',
      uuid: 'tool_result_live_1',
      session_id: 'session_live_1',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: callId, content: 'posted' }]
      }
    }
  ];

  const cardsAt = (through: number) => {
    const events = meshAgentNeutralStreamItems({
      id: 'mesh_claude_live_tool',
      provider: 'claude-code',
      adapter,
      mode: 'live',
      output: records
        .slice(0, through)
        .map((record) => JSON.stringify(record))
        .join('\n')
    });
    return agentObservationCards(events, 'claude-code');
  };
  const shape = (through: number) =>
    cardsAt(through).map((card) => {
      const call = card.payload.call;
      const result = card.payload.result;
      return {
        id: card.id,
        kind: card.kind,
        streaming: card.streaming,
        call: call && typeof call === 'object' && !Array.isArray(call) ? (call as { tool?: unknown }).tool : undefined,
        result:
          result && typeof result === 'object' && !Array.isArray(result)
            ? (result as { tool?: unknown }).tool
            : undefined
      };
    });

  const started = shape(3);
  const firstDelta = shape(4);
  const completeInput = shape(5);
  const authoritative = shape(6);
  const blockStopped = shape(7);
  const messageStopped = shape(8);
  const completed = shape(9);
  const startedRow = observationTimelineRows(observationTimelineEntries(cardsAt(3), 'claude-code'))[0];
  if (!startedRow) throw new Error('Expected the live Read tool row');
  const startedMarkup = renderToStaticMarkup(
    createElement(ObservationTimelineRowView, { provider: 'claude-code', row: startedRow })
  );
  const markupAt = (through: number): string => {
    const row = observationTimelineRows(observationTimelineEntries(cardsAt(through), 'claude-code'))[0];
    if (!row) throw new Error(`Expected the live Read tool row through record ${through}`);
    return renderToStaticMarkup(createElement(ObservationTimelineRowView, { provider: 'claude-code', row }));
  };
  const fileTitle = (markup: string): string | undefined =>
    /data-slot="file-read-card-title-path">([^<]+)</.exec(markup)?.[1];

  expect({
    started,
    firstDelta,
    completeInput,
    authoritative,
    blockStopped,
    messageStopped,
    completed,
    liveCard: {
      kind: /data-tool-kind="([^"]+)"/.exec(startedMarkup)?.[1],
      orb: /data-orb-state="([^"]+)"/.exec(startedMarkup)?.[1],
      title: /data-slot="observation-meta-title">([^<]+)</.exec(startedMarkup)?.[1],
      genericInputFallback: startedMarkup.includes('Read: {}'),
      partialFileName: fileTitle(markupAt(4)),
      completeFileName: fileTitle(markupAt(5))
    },
    stableIds: [
      started[0]?.id,
      firstDelta[0]?.id,
      completeInput[0]?.id,
      authoritative[0]?.id,
      blockStopped[0]?.id,
      messageStopped[0]?.id,
      completed[0]?.id
    ]
  }).toEqual({
    started: [
      {
        id: 'tool_start_live_1:stream-boundary',
        kind: 'tool',
        streaming: true,
        call: { name: 'Read', input: {}, callId },
        result: undefined
      }
    ],
    firstDelta: [
      {
        id: 'tool_start_live_1:stream-boundary',
        kind: 'tool',
        streaming: true,
        call: { name: 'Read', input: { file_path: '/tmp/exam' }, callId },
        result: undefined
      }
    ],
    completeInput: [
      {
        id: 'tool_start_live_1:stream-boundary',
        kind: 'tool',
        streaming: true,
        call: { name: 'Read', input, callId },
        result: undefined
      }
    ],
    authoritative: [
      {
        id: 'tool_start_live_1:stream-boundary',
        kind: 'tool',
        streaming: true,
        call: { name: 'Read', input, callId },
        result: undefined
      }
    ],
    blockStopped: [
      {
        id: 'tool_start_live_1:stream-boundary',
        kind: 'tool',
        streaming: true,
        call: { name: 'Read', input, callId },
        result: undefined
      }
    ],
    messageStopped: [
      {
        id: 'tool_start_live_1:stream-boundary',
        kind: 'tool',
        streaming: true,
        call: { name: 'Read', input, callId },
        result: undefined
      }
    ],
    completed: [
      {
        id: 'tool_start_live_1:stream-boundary',
        kind: 'tool',
        streaming: false,
        call: { name: 'Read', input, callId },
        result: { name: 'tool', output: 'posted', callId, status: 'completed' }
      }
    ],
    liveCard: {
      kind: 'file',
      orb: 'solving',
      title: 'Read',
      genericInputFallback: false,
      partialFileName: 'exam',
      completeFileName: 'example.ts'
    },
    stableIds: Array.from({ length: 7 }, () => 'tool_start_live_1:stream-boundary')
  });
});

test('Claude history and live tool envelopes share the call identity', () => {
  const adapter = builtinAgentAdapters.find((candidate) => candidate.provider === 'claude-code');
  if (!adapter) throw new Error('claude-code adapter is unavailable');
  const callId = 'toolu_shared_history_live';
  const history = adapter.events.projectLive({
    id: 'history_tool',
    mode: 'events',
    output: JSON.stringify({
      type: 'assistant',
      uuid: 'history_assistant',
      message: { content: [{ type: 'tool_use', id: callId, name: 'Write', input: { file_path: '/tmp/a.md' } }] }
    })
  }).events;
  const live = adapter.events.projectLive({
    id: 'live_tool',
    mode: 'live',
    output: [
      {
        type: 'stream_event',
        uuid: 'live_start',
        event: { type: 'message_start', message: { id: 'live_message' } }
      },
      {
        type: 'stream_event',
        uuid: 'live_tool_start',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: callId, name: 'Write', input: {} }
        }
      },
      {
        type: 'assistant',
        uuid: 'live_assistant',
        message: { id: 'live_message', content: [{ type: 'tool_use', id: callId, name: 'Write', input: {} }] }
      }
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')
  }).events;

  expect({
    history: history.find((event) => event.role === 'tool' && event.providerEventType === 'tool_use')?.dedupeKey,
    live: live.find((event) => event.role === 'tool' && event.providerEventType === 'tool_use')?.dedupeKey
  }).toEqual({
    history: `claude-code:tool:${callId}:tool:tool_use`,
    live: `claude-code:tool:${callId}:tool:tool_use`
  });
});

test('Claude live Monad calls use the connecting orb before a result arrives', () => {
  const adapter = builtinAgentAdapters.find((candidate) => candidate.provider === 'claude-code');
  if (!adapter) throw new Error('claude-code adapter is unavailable');
  const records = [
    {
      type: 'stream_event',
      uuid: 'message_start_live_monad',
      session_id: 'session_live_monad',
      event: { type: 'message_start', message: { id: 'message_live_monad', role: 'assistant', content: [] } }
    },
    {
      type: 'stream_event',
      uuid: 'tool_start_live_monad',
      session_id: 'session_live_monad',
      event: {
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'tool_use',
          id: 'toolu_live_monad',
          name: 'mcp__monad__project_post',
          input: {}
        }
      }
    },
    {
      type: 'stream_event',
      uuid: 'tool_delta_live_monad_1',
      session_id: 'session_live_monad',
      event: {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"text":"Project sta' }
      }
    },
    {
      type: 'stream_event',
      uuid: 'tool_delta_live_monad_2',
      session_id: 'session_live_monad',
      event: {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: 'tus"}' }
      }
    }
  ];
  const frame = (through: number) => {
    const events = meshAgentNeutralStreamItems({
      id: 'mesh_claude_live_monad',
      provider: 'claude-code',
      adapter,
      mode: 'live',
      output: records
        .slice(0, through)
        .map((record) => JSON.stringify(record))
        .join('\n')
    });
    const cards = agentObservationCards(events, 'claude-code');
    const row = observationTimelineRows(observationTimelineEntries(cards, 'claude-code'))[0];
    if (!row) throw new Error(`Expected the live Monad tool row through record ${through}`);
    const markup = renderToStaticMarkup(createElement(ObservationTimelineRowView, { provider: 'claude-code', row }));
    const call = cards[0]?.payload.call;
    return {
      kind: /data-tool-kind="([^"]+)"/.exec(markup)?.[1],
      input:
        call && typeof call === 'object' && !Array.isArray(call)
          ? (call as { tool?: { input?: unknown } }).tool?.input
          : undefined,
      text: markup
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    };
  };

  expect([frame(2), frame(3), frame(4)]).toEqual([
    // An in-flight message action with no arguments yet renders no empty-state noise.
    { kind: 'mcp', input: {}, text: 'Posting to project 0s' },
    { kind: 'mcp', input: { text: 'Project sta' }, text: 'Posting to project 0s Project sta' },
    { kind: 'mcp', input: { text: 'Project status' }, text: 'Posting to project 0s Project status' }
  ]);
});

test('recognized Monad tools keep their semantic card while a wrapped input is partial', () => {
  const call = {
    id: 'partial-wrapped-monad',
    kind: 'tool-call' as const,
    streaming: true,
    tool: {
      name: 'monad',
      input: '{"tool":"project_post","arguments":{"text":"Working'
    },
    provenance: { contractEvents: [] }
  };

  expect(monadMcpToolView(call, undefined, [])).toEqual({
    toolName: 'project_post',
    input: { text: 'Working' },
    isError: false,
    action: 'project-post',
    text: 'Working',
    attachments: []
  });
});
