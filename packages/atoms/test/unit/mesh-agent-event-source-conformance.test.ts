import type { MeshAgentObservationProjector } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';

import { codexObservationProjection } from '../../src/agent-adapters/codex/observation/index.ts';
import { createOutputEventSource, createProjectedEventSource } from '../../src/agent-adapters/event-source.ts';
import { builtinAgentAdapters } from '../../src/agent-adapters/index.ts';
import { observation } from '../../src/agent-adapters/observation-projection.ts';

const projection: MeshAgentObservationProjector = {
  recordProjectors: [
    {
      supports: (record) => record.type === 'message',
      parse: ({ id, record, recordIndex }) =>
        observation({
          id: `${id}:${recordIndex}`,
          role: 'agent',
          text: typeof record.text === 'string' ? record.text : undefined,
          source: 'unknown',
          providerEventType: 'message',
          raw: record
        })
    }
  ]
};

test('projected event source gives live and earlier events the same stable identity', () => {
  const source = createProjectedEventSource({ provider: 'codex', projection });
  const output = JSON.stringify({ type: 'message', text: 'Hello' });

  expect(source.projectLive({ id: 'live', output }).events).toEqual([
    {
      id: 'live:0',
      dedupeKey: 'codex:99a3e357:message:agent:message',
      projection: 'normalized',
      role: 'agent',
      text: 'Hello',
      source: 'unknown',
      providerEventType: 'message',
      provenance: { rawEvents: [{ type: 'message', text: 'Hello' }] }
    }
  ]);
  expect(source.projectLive({ id: 'events', output, mode: 'events' }).events[0]?.dedupeKey).toBe(
    'codex:99a3e357:message:agent:message'
  );
});

test('projected event source deduplicates provider records with the same stable uuid across envelope shapes', () => {
  const source = createProjectedEventSource({ provider: 'claude-code', projection });
  const live = {
    type: 'message',
    uuid: 'provider-event-1',
    text: 'Hello',
    session_id: 'session-1',
    tool_use_result: { stdout: 'done' }
  };
  const earlier = {
    type: 'message',
    uuid: 'provider-event-1',
    text: 'Hello',
    sessionId: 'session-1',
    cwd: '/workspace',
    toolUseResult: { stdout: 'done' }
  };

  expect([
    source.projectLive({ id: 'live', output: JSON.stringify(live) }).events[0]?.dedupeKey,
    source.projectLive({ id: 'events', output: JSON.stringify(earlier), mode: 'events' }).events[0]?.dedupeKey
  ]).toEqual([
    'claude-code:provider-event-1:message:agent:message',
    'claude-code:provider-event-1:message:agent:message'
  ]);
});

test('Codex live and history tool events join only through an explicit stable request identity', () => {
  const source = createProjectedEventSource({ provider: 'codex', projection: codexObservationProjection });
  const requestId = 'idem_project_post_20260730';
  const tool = {
    type: 'mcpToolCall',
    server: 'monad',
    tool: 'project_post',
    arguments: { requestId, sessionId: 'ses_1', message: 'continue' },
    result: { content: [{ type: 'text', text: 'accepted' }] }
  };
  const startedEvents = source.projectLive({
    id: 'live',
    output: JSON.stringify({
      type: 'item.started',
      item: { ...tool, id: 'item_1', result: undefined }
    })
  }).events;
  const liveEvents = source.projectLive({
    id: 'live',
    output: JSON.stringify({ type: 'item.completed', item: { ...tool, id: 'item_1' } })
  }).events;
  const historyEvents = source.projectLive({
    id: 'history',
    mode: 'events',
    output: JSON.stringify({
      id: 'turn_1',
      itemsView: 'full',
      status: 'completed',
      items: [{ ...tool, id: 'call_dXENXAGZvUoVMT04WRbM1gaH' }]
    })
  }).events;

  expect({
    started: startedEvents.map((event) => ({ type: event.providerEventType, key: event.dedupeKey })),
    live: liveEvents.map((event) => ({ type: event.providerEventType, key: event.dedupeKey })),
    history: historyEvents
      .filter((event) => event.providerEventType?.startsWith('function_call'))
      .map((event) => ({ type: event.providerEventType, key: event.dedupeKey }))
  }).toEqual({
    started: [{ type: 'function_call', key: `codex:request:${requestId}:tool:function_call` }],
    live: [
      { type: 'function_call', key: `codex:request:${requestId}:tool:function_call` },
      { type: 'function_call_output', key: `codex:request:${requestId}:tool:function_call_output` }
    ],
    history: [
      { type: 'function_call', key: `codex:request:${requestId}:tool:function_call` },
      { type: 'function_call_output', key: `codex:request:${requestId}:tool:function_call_output` }
    ]
  });
});

test('Codex source does not join source-local tool ids without an explicit request identity', () => {
  const source = createProjectedEventSource({ provider: 'codex', projection: codexObservationProjection });
  const tool = {
    type: 'mcpToolCall',
    server: 'monad',
    tool: 'project_post',
    arguments: { sessionId: 'ses_1', message: 'continue' }
  };
  const liveKey = source.projectLive({
    id: 'live',
    output: JSON.stringify({ type: 'item.started', item: { ...tool, id: 'item_1' } })
  }).events[0]?.dedupeKey;
  const historyKey = source
    .projectLive({
      id: 'history',
      mode: 'events',
      output: JSON.stringify({
        id: 'turn_1',
        itemsView: 'full',
        status: 'completed',
        items: [{ ...tool, id: 'call_dXENXAGZvUoVMT04WRbM1gaH' }]
      })
    })
    .events.find((event) => event.providerEventType === 'function_call')?.dedupeKey;

  expect({ liveKey, historyKey, joined: liveKey === historyKey }).toEqual({
    liveKey: 'codex:dd74b194:tool:function_call',
    historyKey: 'codex:call_dXENXAGZvUoVMT04WRbM1gaH:mcpToolCall:tool:function_call',
    joined: false
  });
});

test('projected event source preserves unrecognized provider records as unknown events', () => {
  const source = createProjectedEventSource({ provider: 'codex', projection });
  const raw = { method: 'future/provider/event', params: { value: 1 } };

  expect(source.projectLive({ id: 'live', output: JSON.stringify(raw) }).events).toEqual([
    {
      id: 'live:unknown:0',
      dedupeKey: 'codex:741d960e:system:future/provider/event',
      projection: 'unknown',
      role: 'system',
      text: 'future/provider/event',
      source: 'unknown',
      providerEventType: 'future/provider/event',
      provenance: { rawEvents: [raw] }
    }
  ]);
});

test('projected event source passes event cursors through without interpreting them', async () => {
  const source = createProjectedEventSource({
    provider: 'codex',
    projection,
    readPage: async (_context, request) => ({
      state: 'available',
      view: 'convenience',
      events: [],
      nextCursor: request.before
    })
  });
  const context = { providerSessionRef: 'thread', workingPath: '/tmp/project' };

  expect(
    await source.readPage?.(context, { view: 'convenience', before: 'opaque-provider-cursor', limit: 20 })
  ).toEqual({ state: 'available', view: 'convenience', events: [], nextCursor: 'opaque-provider-cursor' });
});

test('one adapter page capability returns raw or convenience events by requested view', async () => {
  const source = createOutputEventSource({
    provider: 'codex',
    projection,
    readOutput: () => `${JSON.stringify({ type: 'message', text: 'Hello' })}\n`
  });
  const context = { providerSessionRef: 'thread', workingPath: '/tmp/project' };

  expect(await source.readPage?.(context, { view: 'raw', limit: 20 })).toEqual({
    state: 'available',
    view: 'raw',
    records: [{ cursor: '0', data: { type: 'message', text: 'Hello' } }],
    coverage: 'settled'
  });
  expect(await source.readPage?.(context, { view: 'convenience', limit: 20 })).toEqual({
    state: 'available',
    view: 'convenience',
    events: [
      {
        id: 'thread:0',
        dedupeKey: 'codex:99a3e357:message:agent:message',
        projection: 'normalized',
        role: 'agent',
        text: 'Hello',
        source: 'unknown',
        providerEventType: 'message',
        provenance: { rawEvents: [{ type: 'message', text: 'Hello' }] }
      }
    ]
  });
  expect(
    Object.keys(source)
      .filter((key) => key.startsWith('read'))
      .sort()
  ).toEqual(['readPage']);
});

test('every built-in adapter preserves an unrecognized provider record', () => {
  const raw = { method: 'future/provider/event', params: { value: 1 } };

  expect(
    builtinAgentAdapters.map((adapter) => ({
      provider: adapter.provider,
      event: adapter.events?.projectLive({ id: 'live', output: JSON.stringify(raw) }).events[0]
    }))
  ).toEqual(
    builtinAgentAdapters.map((adapter) => ({
      provider: adapter.provider,
      event: {
        id: 'live:unknown:0',
        dedupeKey: `${adapter.provider}:741d960e:system:future/provider/event`,
        projection: 'unknown',
        role: 'system',
        text: 'future/provider/event',
        source: 'unknown',
        providerEventType: 'future/provider/event',
        provenance: { rawEvents: [raw] }
      }
    }))
  );
});

test('Claude event source keeps only the latest cumulative thinking token estimate', () => {
  const adapter = builtinAgentAdapters.find((candidate) => candidate.provider === 'claude-code');
  if (!adapter?.events) throw new Error('Claude event source is required');
  const estimates = [1, 17, 33, 1120];
  const records = estimates.map((estimatedTokens, index) => ({
    type: 'system',
    subtype: 'thinking_tokens',
    estimated_tokens: estimatedTokens,
    estimated_tokens_delta: index === 0 ? estimatedTokens : estimatedTokens - (estimates[index - 1] ?? 0),
    uuid: `thinking_${index}`,
    session_id: 'claude_session'
  }));

  expect(
    adapter.events.projectLive({
      id: 'mesh_claude000000',
      output: records.map((record) => JSON.stringify(record)).join('\n')
    }).events
  ).toMatchObject([
    {
      id: 'thinking_0:thinking-tokens',
      providerEventType: 'thinking_tokens_delta',
      text: 'Thinking… 1120 tokens',
      provenance: { rawEvents: records }
    }
  ]);
});

test('Claude event source starts a new thinking card after a tool boundary', () => {
  const adapter = builtinAgentAdapters.find((candidate) => candidate.provider === 'claude-code');
  if (!adapter?.events) throw new Error('Claude event source is required');
  const output = [
    { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 25 },
    { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 80 },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pwd' } }]
      }
    },
    { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 31 },
    { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 150 }
  ]
    .map((record) => JSON.stringify(record))
    .join('\n');

  expect(
    adapter.events.projectLive({ id: 'mesh_claude000000', output }).events.map((event) => ({
      type: event.providerEventType,
      text: event.text
    }))
  ).toEqual([
    { type: 'thinking_tokens_delta', text: 'Thinking… 80 tokens' },
    { type: 'tool_use', text: 'Tool call Bash {"command":"pwd"}' },
    { type: 'thinking_tokens_delta', text: 'Thinking… 150 tokens' }
  ]);
});

test('Claude event source reconciles interleaved live blocks with the authoritative assistant message', () => {
  const adapter = builtinAgentAdapters.find((candidate) => candidate.provider === 'claude-code');
  if (!adapter?.events) throw new Error('Claude event source is required');
  const messageId = 'msg_011CdvJ8vJZPvAr4RSiDXEY1';
  const records = [
    { type: 'stream_event', event: { type: 'message_start', message: { id: messageId } }, uuid: 'stream-1' },
    {
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      uuid: 'stream-2'
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Need ' } },
      uuid: 'stream-3'
    },
    { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 61, uuid: 'tokens-1' },
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'context.' } },
      uuid: 'stream-4'
    },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 }, uuid: 'stream-5' },
    {
      type: 'stream_event',
      event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      uuid: 'stream-6'
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Final ' } },
      uuid: 'stream-7'
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer.' } },
      uuid: 'stream-8'
    },
    {
      type: 'assistant',
      uuid: 'assistant-thinking',
      message: {
        id: messageId,
        content: [{ type: 'thinking', thinking: 'Need context.', signature: 'signed' }]
      }
    },
    {
      type: 'assistant',
      uuid: 'assistant-text',
      message: {
        id: messageId,
        content: [{ type: 'text', text: 'Final answer.' }]
      }
    },
    { type: 'result', uuid: 'result-1', result: 'Final answer.', is_error: false }
  ];

  expect(
    adapter.events
      .projectLive({ id: 'mesh_claude000000', output: records.map((record) => JSON.stringify(record)).join('\n') })
      .events.map((event) => ({
        role: event.role,
        type: event.providerEventType,
        text: event.text,
        summary: event.summary
      }))
  ).toEqual([
    { role: 'agent', type: 'thinking', text: 'Need context.', summary: 'Thinking… 61 tokens' },
    { role: 'agent', type: 'assistant', text: 'Final answer.', summary: undefined },
    { role: 'agent', type: 'result', text: 'Final answer.', summary: undefined }
  ]);
});

test('Codex live and history message envelopes share semantic dedupe identities', () => {
  const source = createProjectedEventSource({ provider: 'codex', projection: codexObservationProjection });
  const turnId = 'turn_1';
  const text = 'The live answer is complete.';
  const live = source.projectLive({
    id: 'live',
    output: [
      JSON.stringify({
        method: 'item/started',
        params: { threadId: 'thread_1', turnId, item: { type: 'agentMessage', id: 'live-item', text: '' } }
      }),
      JSON.stringify({
        method: 'item/completed',
        params: { threadId: 'thread_1', turnId, item: { type: 'agentMessage', id: 'live-item', text } }
      })
    ].join('\n')
  }).events;
  const history = source.projectLive({
    id: 'history',
    mode: 'events',
    output: JSON.stringify({
      id: turnId,
      itemsView: 'full',
      status: 'completed',
      items: [{ type: 'agentMessage', id: 'item-13', text }]
    })
  }).events;
  const userText = 'The user message is complete.';
  const liveUser = source.projectLive({
    id: 'live-user',
    output: JSON.stringify({
      method: 'item/completed',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_2',
        item: { type: 'userMessage', id: 'live-user-item', content: [{ type: 'text', text: userText }] }
      }
    })
  }).events;
  const historyUser = source.projectLive({
    id: 'history-user',
    mode: 'events',
    output: JSON.stringify({
      id: 'turn_2',
      itemsView: 'full',
      status: 'completed',
      items: [{ type: 'userMessage', id: 'item-14', content: [{ type: 'text', text: userText }] }]
    })
  }).events;

  expect({
    live: live.find((event) => event.role === 'agent')?.dedupeKey,
    history: history.find((event) => event.role === 'agent')?.dedupeKey,
    liveUser: liveUser.find((event) => event.role === 'user')?.dedupeKey,
    historyUser: historyUser.find((event) => event.role === 'user')?.dedupeKey
  }).toEqual({
    live: 'codex:turn:turn_1:message:agent:6461d3ff:agent:item/agentMessage',
    history: 'codex:turn:turn_1:message:agent:6461d3ff:agent:item/agentMessage',
    liveUser: 'codex:turn:turn_2:message:user:ae2abba7:user:item/userMessage',
    historyUser: 'codex:turn:turn_2:message:user:ae2abba7:user:item/userMessage'
  });
});

test('a coalesced streaming run keeps one identity as further deltas arrive', () => {
  const deltaProjection: MeshAgentObservationProjector = {
    isStreamingFragment: (event) => event.providerEventType === 'reasoning.delta',
    recordProjectors: [
      {
        parse: ({ id, record, recordIndex }) =>
          observation({
            id: `${id}:${recordIndex}`,
            role: 'agent',
            text: typeof record.delta === 'string' ? record.delta : undefined,
            source: 'unknown',
            providerEventType: 'reasoning.delta',
            raw: record
          })
      }
    ]
  };
  const source = createProjectedEventSource({ provider: 'openclaw', projection: deltaProjection });
  const delta = (text: string) => JSON.stringify({ type: 'reasoning', delta: text });
  const project = (...deltas: string[]) => source.projectLive({ id: 'live', output: deltas.join('\n') }).events;

  const first = project(delta('Chec'));
  const second = project(delta('Chec'), delta('king the repo'));

  const runIdentity = 'openclaw:e4e60836:reasoning:agent:reasoning.delta';
  expect([
    first.map((event) => ({ dedupeKey: event.dedupeKey, text: event.text })),
    second.map((event) => ({ dedupeKey: event.dedupeKey, text: event.text }))
  ]).toEqual([[{ dedupeKey: runIdentity, text: 'Chec' }], [{ dedupeKey: runIdentity, text: 'Checking the repo' }]]);
});
