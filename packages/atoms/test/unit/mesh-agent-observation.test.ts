import type { AgentObservationEvent, MeshAgentObservationEvent } from '@monad/protocol';
import type { AgentObservationCard } from '../../src/agent-adapters/observation-cards.ts';
import type { ObservationTimelineEntry } from '../../src/workplace-experiences/chat-room/components/observation/types.ts';

import { expect, test } from 'bun:test';

import { builtinAgentAdapters } from '../../src/agent-adapters/index.ts';
import { toAgentObservationEvent } from '../../src/agent-adapters/neutral-observation.ts';
import { agentObservationCards } from '../../src/agent-adapters/observation-cards.ts';
import { rawJsonText } from '../../src/workplace-experiences/chat-room/components/observation/card-shell.tsx';
import { imageToolView } from '../../src/workplace-experiences/chat-room/components/observation/image-tool-card.tsx';
import {
  observationContractRawEvents,
  observationRawEvents
} from '../../src/workplace-experiences/chat-room/components/observation/provenance.ts';
import {
  observationTimelineEntries,
  observationTimelineRows,
  reconcileObservationItems,
  reconcileObservationTimelineRows
} from '../../src/workplace-experiences/chat-room/components/observation/timeline.tsx';
import {
  configureMeshAgentObservationAdapterResolver,
  meshAgentNeutralStreamItems,
  meshAgentStreamItems,
  meshAgentUsageLimitMeter,
  meshAgentUsageLimitMeterFromResponse
} from '../../src/workplace-experiences/experience/mesh-agent-observation/mesh-agent-observation.ts';

configureMeshAgentObservationAdapterResolver((provider) =>
  builtinAgentAdapters.find((adapter) => adapter.provider === provider)
);

test('Codex live and history records project the same turn boundaries', () => {
  const live = meshAgentNeutralStreamItems({
    id: 'mesh_codex_live',
    provider: 'codex',
    mode: 'events',
    output: [
      JSON.stringify({ method: 'turn/started', params: { turn: { id: 'turn_1', startedAt: 1_784_000_000 } } }),
      JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'turn_1', completedAt: 1_784_000_030 } } })
    ].join('\n')
  });
  const history = meshAgentNeutralStreamItems({
    id: 'mesh_codex_history',
    provider: 'codex',
    mode: 'events',
    output: [
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn_1', started_at: 1_784_000_000 }
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'turn_1', completed_at: 1_784_000_030 }
      })
    ].join('\n')
  });

  expect({
    history: history.map(({ at, kind, reason }) => ({ at, kind, reason })),
    live: live.map(({ at, kind, reason }) => ({ at, kind, reason }))
  }).toEqual({
    history: [
      { at: '2026-07-14T03:33:20.000Z', kind: 'turn-start', reason: undefined },
      { at: '2026-07-14T03:33:50.000Z', kind: 'turn-end', reason: 'completed' }
    ],
    live: [
      { at: '2026-07-14T03:33:20.000Z', kind: 'turn-start', reason: undefined },
      { at: '2026-07-14T03:33:50.000Z', kind: 'turn-end', reason: 'completed' }
    ]
  });
});

test('Claude history starts on text prompts, not tool results, and ends on the settled assistant message', () => {
  const events = meshAgentNeutralStreamItems({
    id: 'mesh_claude_history',
    provider: 'claude-code',
    mode: 'events',
    output: [
      JSON.stringify({
        type: 'user',
        sessionId: 'session_1',
        timestamp: '2026-07-14T08:53:20.000Z',
        uuid: 'user_1',
        message: { role: 'user', content: [{ type: 'text', text: 'Inspect the repository.' }] }
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 'session_1',
        uuid: 'assistant_tool',
        message: {
          id: 'msg_tool',
          role: 'assistant',
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'tool_1', name: 'Read', input: { file_path: 'README.md' } }]
        }
      }),
      JSON.stringify({
        type: 'user',
        sessionId: 'session_1',
        uuid: 'tool_result_1',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'repository read' }]
        }
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 'session_1',
        timestamp: '2026-07-14T08:53:50.000Z',
        uuid: 'assistant_final',
        message: {
          id: 'msg_final',
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Inspection complete.' }]
        }
      })
    ].join('\n')
  });

  expect(events.map(({ kind, reason, text }) => ({ kind, reason, text }))).toEqual([
    { kind: 'turn-start', reason: undefined, text: 'Turn started' },
    { kind: 'user-message', reason: undefined, text: 'Inspect the repository.' },
    { kind: 'tool-call', reason: undefined, text: 'Tool call Read {"file_path":"README.md"}' },
    { kind: 'tool-result', reason: undefined, text: 'repository read' },
    { kind: 'assistant-message', reason: undefined, text: 'Inspection complete.' },
    { kind: 'turn-end', reason: 'completed', text: 'Turn completed' }
  ]);
});

test('Claude live output ends once from result instead of also ending on its assistant snapshot', () => {
  const events = meshAgentNeutralStreamItems({
    id: 'mesh_claude_live',
    provider: 'claude-code',
    mode: 'live',
    output: [
      JSON.stringify({
        type: 'user',
        session_id: 'session_1',
        uuid: 'user_live',
        message: { role: 'user', content: [{ type: 'text', text: 'Inspect the repository.' }] }
      }),
      JSON.stringify({
        type: 'assistant',
        session_id: 'session_1',
        uuid: 'assistant_live',
        message: {
          id: 'msg_final',
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Inspection complete.' }]
        }
      }),
      JSON.stringify({ type: 'result', session_id: 'session_1', subtype: 'success', result: 'Inspection complete.' })
    ].join('\n')
  });

  expect(events.map(({ kind, reason }) => ({ kind, reason }))).toEqual([
    { kind: 'turn-start', reason: undefined },
    { kind: 'user-message', reason: undefined },
    { kind: 'assistant-message', reason: undefined },
    { kind: 'turn-end', reason: 'completed' }
  ]);
});

test('Claude live and history projection ids are based on provider UUIDs', () => {
  const message = {
    type: 'assistant',
    uuid: 'assistant_uuid_1',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Projection identity follows Claude.' }]
    }
  };
  const live = meshAgentStreamItems({
    id: 'mesh_claude_live',
    provider: 'claude-code',
    mode: 'live',
    output: JSON.stringify({ ...message, session_id: 'session_1' })
  });
  const history = meshAgentStreamItems({
    id: 'mesh_claude_history',
    provider: 'claude-code',
    mode: 'events',
    output: JSON.stringify(message)
  });

  expect({
    live: live.map(({ id, providerEventType, text }) => ({ id, providerEventType, text })),
    history: history.map(({ id, providerEventType, text }) => ({ id, providerEventType, text }))
  }).toEqual({
    live: [
      {
        id: 'assistant_uuid_1:message:0',
        providerEventType: 'assistant',
        text: 'Projection identity follows Claude.'
      }
    ],
    history: [
      {
        id: 'assistant_uuid_1:message:0',
        providerEventType: 'assistant',
        text: 'Projection identity follows Claude.'
      }
    ]
  });
});

const cardsFromNeutral = (items: readonly AgentObservationEvent[], provider: string): AgentObservationCard[] =>
  agentObservationCards(items, provider);

const cardsFromEvents = (provider: string, ...events: AgentObservationEvent[]): AgentObservationCard[] =>
  cardsFromNeutral(events, provider);

const cardEventPayload = (card: AgentObservationCard): AgentObservationEvent | undefined => {
  const event = card.payload.event ?? card.payload.call ?? card.payload.result;
  return event && typeof event === 'object' && !Array.isArray(event) ? (event as AgentObservationEvent) : undefined;
};

const cardToolCallPayload = (card: AgentObservationCard): AgentObservationEvent | undefined => {
  const event = card.payload.call;
  return event && typeof event === 'object' && !Array.isArray(event) ? (event as AgentObservationEvent) : undefined;
};

const cardToolResultPayload = (card: AgentObservationCard): AgentObservationEvent | undefined => {
  const event = card.payload.result;
  return event && typeof event === 'object' && !Array.isArray(event) ? (event as AgentObservationEvent) : undefined;
};

const cardFromEvent = (event: AgentObservationEvent, provider = 'codex'): AgentObservationCard => {
  const card = cardsFromNeutral([event], provider)[0];
  if (!card) {
    throw new Error('Expected event to project to a card');
  }
  return card;
};

const messageCard = (id: string, text: string, streaming = false, provider = 'codex'): AgentObservationCard =>
  cardFromEvent(
    {
      id,
      kind: 'assistant-message',
      streaming,
      text,
      provenance: { contractEvents: [{ id, text }] }
    },
    provider
  );

// The timeline renders adapter-owned AgentObservationCard[]; these tests build legacy events (via
// meshAgentStreamItems), so convert them the same way the daemon's ui plane does before rendering.
const renderTimeline = (items: MeshAgentObservationEvent[], provider = 'codex') =>
  observationTimelineEntries(
    cardsFromNeutral(
      items
        .map((event) => toAgentObservationEvent(event))
        .filter((event): event is AgentObservationEvent => event !== null),
      provider
    ),
    provider
  );

const externalSnapshot = (event: MeshAgentObservationEvent) => {
  const { provenance, ...rest } = event;
  return { ...rest, rawEvents: provenance.rawEvents };
};

const neutralSnapshot = (event: AgentObservationEvent) => {
  const { provenance, ...rest } = event;
  return { ...rest, rawEvents: observationRawEvents(event) };
};

test('host MeshAgent usage records project to a usage limits meter', () => {
  const meter = meshAgentUsageLimitMeterFromResponse({
    agentName: 'codex',
    provider: 'codex',
    checkedAt: '2026-07-03T00:00:00.000Z',
    records: [
      {
        name: 'daily',
        resetAt: '2026-07-03T12:00:00.000Z',
        max: 100,
        current: 12
      }
    ]
  });

  expect(meter).toMatchObject({
    title: 'Usage remaining',
    rows: [{ id: 'daily', label: 'daily', percent: 12 }]
  });
});

test('Claude Code observation preserves assistant and result identities even when their text matches', () => {
  const output = [
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Joined the project and posted status.' }]
      }
    }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'Joined the project and posted status.'
    })
  ].join('\n');

  expect(
    meshAgentStreamItems({ id: 'mesh_claude000000', provider: 'claude-code', output }).map((item) => item.text)
  ).toEqual(['Joined the project and posted status.', 'Joined the project and posted status.']);
});

test('Claude Code observation maps server errors to readable system events', () => {
  const output = JSON.stringify({
    type: 'result',
    subtype: 'server_error',
    is_error: true,
    result: 'API Error: overloaded_error. Claude Code is currently overloaded.',
    session_id: 'claude-session'
  });

  expect(
    meshAgentStreamItems({ id: 'mesh_claude000000', provider: 'claude-code', output }).map(externalSnapshot)
  ).toEqual([
    {
      id: 'mesh_claude000000:result',
      role: 'system',
      text: 'API Error: overloaded_error. Claude Code is currently overloaded.',
      source: 'claude-code-sdk',
      providerEventType: 'server_error',
      rawEvents: [
        {
          type: 'result',
          subtype: 'server_error',
          is_error: true,
          result: 'API Error: overloaded_error. Claude Code is currently overloaded.',
          session_id: 'claude-session'
        }
      ]
    }
  ]);
});

test('Qwen Code observation uses SDK-shaped assistant and result messages', () => {
  const output = [
    JSON.stringify({
      type: 'system',
      subtype: 'session_start',
      uuid: 'sys_1',
      session_id: 'qwen-session',
      cwd: '/tmp/project'
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'msg_100000000000',
      session_id: 'qwen-session',
      message: {
        id: 'assistant_1',
        type: 'message',
        role: 'assistant',
        model: 'qwen3-coder-plus',
        content: [{ type: 'text', text: 'I will inspect the project first.' }],
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      parent_tool_use_id: null
    }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      uuid: 'result_1',
      session_id: 'qwen-session',
      is_error: false,
      duration_ms: 1000,
      duration_api_ms: 900,
      num_turns: 1,
      result: 'I will inspect the project first.',
      usage: { input_tokens: 1, output_tokens: 1 },
      permission_denials: []
    })
  ].join('\n');

  const items = meshAgentStreamItems({ id: 'mesh_qwen00000000', provider: 'qwen', output });

  expect(
    items.map((item) => ({ role: item.role, source: item.source, type: item.providerEventType, text: item.text }))
  ).toEqual([
    { role: 'system', source: 'qwen-code-sdk', type: 'system', text: 'session_start' },
    { role: 'agent', source: 'qwen-code-sdk', type: 'assistant', text: 'I will inspect the project first.' },
    { role: 'agent', source: 'qwen-code-sdk', type: 'result', text: 'I will inspect the project first.' }
  ]);
});

test('Codex app-server observation renders reasoning and diff streams', () => {
  const output = [
    JSON.stringify({ method: 'item/reasoning/summaryTextDelta', params: { itemId: 'r1', delta: 'Considering ' } }),
    JSON.stringify({ method: 'item/reasoning/summaryTextDelta', params: { itemId: 'r1', delta: 'the plan.' } }),
    JSON.stringify({ method: 'turn/diff/updated', params: { threadId: 't', turnId: 'u', diff: '--- a\n+++ b\n' } })
  ].join('\n');

  const items = meshAgentStreamItems({ id: 'mesh_codex0000000', provider: 'codex', output });
  expect(
    items.map((item) => ({
      hasContent: item.hasContent,
      role: item.role,
      summary: item.summary,
      type: item.providerEventType,
      text: item.text
    }))
  ).toEqual([
    {
      hasContent: false,
      role: 'agent',
      summary: 'Considering the plan.',
      type: 'item/reasoning/delta',
      text: 'Thinking…'
    },
    { hasContent: undefined, role: 'tool', summary: undefined, type: 'turn/diff/updated', text: '--- a\n+++ b\n' }
  ]);
});

test('Codex app-server observation preserves empty reasoning lifecycle duration without inventing content', () => {
  const started = {
    method: 'item/started',
    params: {
      item: {
        type: 'reasoning',
        id: 'rs_07e1f6db02b0e58e016a77f17068bc8191a8b4d524888cfcba',
        summary: [],
        content: []
      },
      threadId: '019fe486-f89f-7920-ac20-dfca5e27a2e8',
      turnId: '019fe486-fa58-7790-8b84-377260e325cd',
      startedAtMs: 1_786_245_488_329
    },
    emittedAtMs: 1_786_245_488_329
  };
  const completed = {
    method: 'item/completed',
    params: {
      item: {
        type: 'reasoning',
        id: 'rs_07e1f6db02b0e58e016a77f17068bc8191a8b4d524888cfcba',
        summary: [],
        content: []
      },
      threadId: '019fe486-f89f-7920-ac20-dfca5e27a2e8',
      turnId: '019fe486-fa58-7790-8b84-377260e325cd',
      completedAtMs: 1_786_245_489_125
    },
    emittedAtMs: 1_786_245_489_125
  };

  expect(
    meshAgentNeutralStreamItems({
      id: 'mesh_codex0000000',
      provider: 'codex',
      output: [started, completed].map((record) => JSON.stringify(record)).join('\n')
    }).map(({ at, durationMs, hasContent, kind, text }) => ({ at, durationMs, hasContent, kind, text }))
  ).toEqual([
    {
      at: '2026-08-09T03:18:09.125Z',
      durationMs: 796,
      hasContent: false,
      kind: 'reasoning',
      text: 'Thinking…'
    }
  ]);

  const adapter = builtinAgentAdapters.find((candidate) => candidate.provider === 'codex');
  if (!adapter?.events) throw new Error('Expected Codex observation adapter');
  const projector = adapter.events.createLiveProjector?.({ id: 'mesh_codex0000000' });
  if (!projector) throw new Error('Expected Codex live observation projector');
  const [liveStarted] = projector.advance(`${JSON.stringify(started)}\n`).events;
  const [liveCompleted] = projector.advance(`${JSON.stringify(completed)}\n`).events;
  if (!liveStarted || !liveCompleted) throw new Error('Expected the Codex reasoning lifecycle to remain projected');

  expect({
    completed: {
      durationMs: liveCompleted.durationMs,
      hasContent: liveCompleted.hasContent,
      id: liveCompleted.id,
      type: liveCompleted.providerEventType
    },
    started: {
      durationMs: liveStarted.durationMs,
      hasContent: liveStarted.hasContent,
      id: liveStarted.id,
      type: liveStarted.providerEventType
    }
  }).toEqual({
    completed: {
      durationMs: 796,
      hasContent: false,
      id: liveStarted.id,
      type: 'item/reasoning/completed'
    },
    started: {
      durationMs: undefined,
      hasContent: false,
      id: liveStarted.id,
      type: 'item/reasoning/delta'
    }
  });
});

test('Codex app-server observation renders the completed reasoning summary when deltas are absent', () => {
  const summaryItem = {
    type: 'reasoning',
    id: 'reasoning-1',
    summary: ['Inspecting the project.', 'Checking the tests.'],
    content: ['Raw reasoning fallback.']
  };
  const contentItem = {
    type: 'reasoning',
    id: 'reasoning-2',
    summary: [],
    content: ['Raw reasoning fallback.']
  };
  const lifecycle = (item: typeof summaryItem) =>
    [
      JSON.stringify({
        method: 'item/started',
        params: { threadId: 'thread-1', turnId: 'turn-1', item: { ...item, summary: [], content: [] } }
      }),
      JSON.stringify({
        method: 'item/completed',
        params: { threadId: 'thread-1', turnId: 'turn-1', item }
      })
    ].join('\n');

  expect(
    [summaryItem, contentItem].map((item) =>
      meshAgentNeutralStreamItems({ id: 'mesh_codex0000000', provider: 'codex', output: lifecycle(item) }).map(
        ({ kind, summary, text }) => ({ kind, summary, text })
      )
    )
  ).toEqual([
    [
      {
        kind: 'reasoning',
        summary: undefined,
        text: 'Inspecting the project.\n\nChecking the tests.\n\nRaw reasoning fallback.'
      }
    ],
    [{ kind: 'reasoning', summary: undefined, text: 'Raw reasoning fallback.' }]
  ]);
});

test('MeshAgent observation projects thinking records from all adapters', () => {
  const cases = [
    {
      provider: 'claude-code',
      output: JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'thinking', thinking: 'checking files' }] }
      }),
      source: 'claude-code-sdk',
      type: 'thinking',
      text: 'checking files'
    },
    {
      provider: 'qwen',
      output: JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'thinking', thinking: 'checking files' }] }
      }),
      source: 'qwen-code-sdk',
      type: 'thinking',
      text: 'checking files'
    },
    {
      provider: 'gemini',
      output: JSON.stringify({ type: 'reasoning', reasoning: 'planning next step' }),
      source: 'gemini-cli',
      type: 'reasoning',
      text: 'planning next step'
    },
    {
      provider: 'codex',
      output: JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', text: 'considering patch' } }),
      source: 'codex-exec',
      type: 'reasoning',
      text: 'considering patch'
    }
  ];

  for (const expected of cases) {
    const [item] = meshAgentStreamItems({
      id: `mesh_${expected.provider}`,
      provider: expected.provider,
      output: expected.output
    });
    expect(item).toMatchObject({
      role: 'agent',
      source: expected.source,
      providerEventType: expected.type,
      text: expected.text
    });
    const [entry] = renderTimeline(item ? [item] : []);
    expect(entry?.kind === 'public' ? entry.card.kind : entry?.kind).toBe('reasoning');
  }
});

test('MeshAgent observation merges streaming thinking deltas', () => {
  const claudeOutput = [
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Analyzing ' } }
    }),
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'context.' } }
    })
  ].join('\n');
  const qwenOutput = [
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Checking ' } }
    }),
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'state.' } }
    })
  ].join('\n');

  expect(
    meshAgentStreamItems({ id: 'mesh_claude000000', provider: 'claude-code', output: claudeOutput })
  ).toMatchObject([
    {
      role: 'agent',
      source: 'claude-code-sdk',
      providerEventType: 'thinking_delta',
      text: 'Analyzing context.'
    }
  ]);
  expect(meshAgentStreamItems({ id: 'mesh_qwen00000000', provider: 'qwen', output: qwenOutput })).toMatchObject([
    {
      role: 'agent',
      source: 'qwen-code-sdk',
      providerEventType: 'thinking_delta',
      text: 'Checking state.'
    }
  ]);
});

test('Claude Code observation keeps partial thinking and drops the empty settled block', () => {
  const output = [
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Inspecting ' } }
    }),
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'the project.' } }
    }),
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: '', signature: 'signed' }] }
    })
  ].join('\n');

  expect(meshAgentNeutralStreamItems({ id: 'mesh_claude000000', provider: 'claude-code', output })).toMatchObject([
    {
      kind: 'reasoning',
      streaming: true,
      text: 'Inspecting the project.'
    }
  ]);
});

test('Claude Code observation keeps the latest thinking token estimate in one reasoning item', () => {
  const first = {
    type: 'system',
    subtype: 'thinking_tokens',
    estimated_tokens: 42,
    estimated_tokens_delta: 42,
    uuid: 'thinking_1',
    session_id: 'claude_session'
  };
  const latest = {
    type: 'system',
    subtype: 'thinking_tokens',
    estimated_tokens: 151,
    estimated_tokens_delta: 109,
    uuid: 'thinking_2',
    session_id: 'claude_session'
  };
  const items = meshAgentNeutralStreamItems({
    id: 'mesh_claude000000',
    provider: 'claude-code',
    output: [JSON.stringify(first), JSON.stringify(latest)].join('\n')
  });

  expect(items.map(neutralSnapshot)).toEqual([
    {
      id: 'thinking_1:thinking-tokens',
      kind: 'reasoning',
      streaming: true,
      text: 'Thinking… 151 tokens',
      rawEvents: [first, latest]
    }
  ]);
});

test('thinking timeline rows use dedupe identity and keep each run raw', () => {
  const firstRaw = [{ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 25, uuid: 'think-a' }];
  const secondRaw = [{ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 80, uuid: 'think-b' }];
  const entries = observationTimelineEntries(
    cardsFromNeutral(
      [
        {
          id: 'mesh_claude:thinking-tokens',
          dedupeKey: 'claude-code:think-a:agent:thinking_tokens_delta',
          kind: 'reasoning',
          streaming: true,
          text: 'Thinking… 25 tokens',
          provenance: { contractEvents: firstRaw }
        },
        {
          id: 'mesh_claude:thinking-tokens',
          dedupeKey: 'claude-code:think-b:agent:thinking_tokens_delta',
          kind: 'reasoning',
          streaming: true,
          text: 'Thinking… 80 tokens',
          provenance: { contractEvents: secondRaw }
        }
      ],
      'claude-code'
    ),
    'claude-code'
  );

  expect(
    entries.map(({ id, contractEvents }) => ({ id, rawEvents: observationContractRawEvents(contractEvents) }))
  ).toEqual([
    { id: 'claude-code:think-a:agent:thinking_tokens_delta', rawEvents: firstRaw },
    { id: 'claude-code:think-b:agent:thinking_tokens_delta', rawEvents: secondRaw }
  ]);
});

test('Codex WARN and ERROR logs project to diagnostic cards without ending the turn', () => {
  const errorRecord = {
    timestamp: '2026-07-17T12:40:09.794106Z',
    level: 'ERROR',
    fields: { message: 'failed to refresh available models: timeout waiting for child process to exit' },
    target: 'codex_models_manager::manager'
  };
  const warningRecord = {
    timestamp: '2026-07-17T12:38:05.227290Z',
    level: 'WARN',
    fields: {
      message: 'failed to warm remote plugin catalog cache',
      error:
        'failed to parse remote plugin catalog response from https://chatgpt.com/backend-api/ps/plugins/list: EOF while parsing a value at line 1 column 0'
    },
    target: 'codex_core_plugins::manager'
  };
  const items = meshAgentNeutralStreamItems({
    id: 'mesh_codex0000000',
    provider: 'codex',
    output: [JSON.stringify(errorRecord), JSON.stringify(warningRecord)].join('\n')
  });

  expect(items.map(neutralSnapshot)).toEqual([
    {
      id: 'mesh_codex0000000:diagnostic',
      kind: 'system',
      streaming: false,
      text: 'failed to refresh available models: timeout waiting for child process to exit',
      diagnostic: {
        severity: 'error',
        message: 'failed to refresh available models: timeout waiting for child process to exit',
        target: 'codex_models_manager::manager'
      },
      rawEvents: [errorRecord],
      at: '2026-07-17T12:40:09.794Z'
    },
    {
      id: 'mesh_codex0000000:json:1:diagnostic',
      kind: 'system',
      streaming: false,
      text: 'failed to warm remote plugin catalog cache',
      diagnostic: {
        severity: 'warning',
        message: 'failed to warm remote plugin catalog cache',
        detail:
          'failed to parse remote plugin catalog response from https://chatgpt.com/backend-api/ps/plugins/list: EOF while parsing a value at line 1 column 0',
        target: 'codex_core_plugins::manager'
      },
      rawEvents: [warningRecord],
      at: '2026-07-17T12:38:05.227Z'
    }
  ]);
});

test('Qwen Code observation merges partial stream-json deltas', () => {
  const output = [
    JSON.stringify({
      type: 'stream_event',
      uuid: 'delta_1',
      session_id: 'qwen-session',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
      parent_tool_use_id: null
    }),
    JSON.stringify({
      type: 'stream_event',
      uuid: 'delta_2',
      session_id: 'qwen-session',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
      parent_tool_use_id: null
    })
  ].join('\n');

  expect(meshAgentStreamItems({ id: 'mesh_qwen00000000', provider: 'qwen', output })).toMatchObject([
    {
      role: 'agent',
      source: 'qwen-code-sdk',
      providerEventType: 'content_block_delta',
      text: 'hello world'
    }
  ]);
});

test('observation preserves unparsed JSONL records verbatim', () => {
  const raw = '{"type":"unexpected_event","payload":{"value":42}}';

  expect(
    meshAgentStreamItems({ id: 'mesh_unknown00000', provider: 'claude-code', output: raw }).map(externalSnapshot)
  ).toEqual([
    {
      id: 'mesh_unknown00000:json:0:raw',
      role: 'system',
      text: raw,
      source: 'unknown',
      providerEventType: 'raw_json',
      rawEvents: [{ type: 'unexpected_event', payload: { value: 42 } }]
    }
  ]);
});

test('observation does not promote embedded JSON fragments to raw cards', () => {
  const output = [
    'Codex app-server log:',
    JSON.stringify({
      jsonrpc: '2.0',
      id: 12,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              method: 'project_read',
              params: { file: 'packages/atoms/src/index.ts' }
            })
          }
        ]
      }
    }),
    'done'
  ].join(' ');

  expect(meshAgentStreamItems({ id: 'mesh_codex0000000', provider: 'codex', output })).toEqual([
    {
      id: 'mesh_codex0000000:0',
      role: 'agent',
      text: output,
      source: 'plain-text',
      provenance: { rawEvents: [output] }
    }
  ]);
});

test('Codex app-server observation merges adjacent agent message chunks', () => {
  const output = [
    JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { delta: 'Hello' }
    }),
    JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { delta: ', world' }
    })
  ].join('\n');

  expect(meshAgentStreamItems({ id: 'mesh_codex0000000', provider: 'codex', output }).map((item) => item.text)).toEqual(
    ['Hello, world']
  );
});

test('Codex app-server observation collects merged chunk raw JSONL lines into a flat array', () => {
  const records = [
    { method: 'item/agentMessage/delta', params: { delta: 'a' } },
    { method: 'item/agentMessage/delta', params: { delta: 'b' } },
    { method: 'item/agentMessage/delta', params: { delta: 'c' } }
  ];
  const rawLines = records.map((record) => JSON.stringify(record));
  const output = rawLines.join('\n');

  const items = meshAgentStreamItems({ id: 'mesh_codex0000000', provider: 'codex', output });

  expect(items).toHaveLength(1);
  expect(items[0]?.text).toBe('abc');
  expect(items[0]?.provenance.rawEvents).toEqual(records);
  expect(rawJsonText(items[0]?.provenance.rawEvents)).toBe(output);
});

test('Codex app-server observation groups one agent message item lifecycle into one card', () => {
  const records = [
    {
      method: 'item/started',
      params: {
        item: { type: 'agentMessage', id: 'msg_100000000000', text: '', phase: 'commentary' },
        threadId: 'thread_1',
        turnId: 'turn_1',
        startedAtMs: 1
      }
    },
    {
      method: 'item/agentMessage/delta',
      params: {
        itemId: 'msg_100000000000',
        threadId: 'thread_1',
        turnId: 'turn_1',
        delta: "I'll fetch zeke's pending message now."
      }
    },
    {
      method: 'item/completed',
      params: {
        item: {
          type: 'agentMessage',
          id: 'msg_100000000000',
          text: "I'll fetch zeke's pending message now.",
          phase: 'commentary'
        },
        threadId: 'thread_1',
        turnId: 'turn_1',
        completedAtMs: 2
      }
    }
  ];
  const rawLines = records.map((record) => JSON.stringify(record));
  const output = rawLines.join('\n');

  const items = meshAgentStreamItems({ id: 'mesh_codex0000000', provider: 'codex', output });

  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    role: 'agent',
    source: 'codex-app-server',
    providerEventType: 'item/agentMessage',
    text: "I'll fetch zeke's pending message now."
  });
  expect(items[0]?.provenance.rawEvents).toEqual(records);
  expect(rawJsonText(items[0]?.provenance.rawEvents)).toBe(output);
});

test('Codex app-server observation shows only the latest indexed reasoning summary while streaming', () => {
  const records = [
    {
      method: 'item/reasoning/summaryPartAdded',
      params: { threadId: 'thread_1', turnId: 'turn_1', itemId: 'reasoning_1', summaryIndex: 0 }
    },
    {
      method: 'item/reasoning/summaryTextDelta',
      params: { threadId: 'thread_1', turnId: 'turn_1', itemId: 'reasoning_1', summaryIndex: 0, delta: 'Plan A' }
    },
    {
      method: 'item/reasoning/summaryPartAdded',
      params: { threadId: 'thread_1', turnId: 'turn_1', itemId: 'reasoning_1', summaryIndex: 1 }
    },
    {
      method: 'item/reasoning/summaryTextDelta',
      params: { threadId: 'thread_1', turnId: 'turn_1', itemId: 'reasoning_1', summaryIndex: 1, delta: 'Plan B' }
    }
  ];

  expect(
    meshAgentNeutralStreamItems({
      id: 'mesh_codex0000000',
      provider: 'codex',
      output: records.map((record) => JSON.stringify(record)).join('\n')
    }).map(({ kind, summary, text }) => ({ kind, summary, text }))
  ).toEqual([{ kind: 'reasoning', summary: 'Plan B', text: 'Thinking…' }]);
});

test('Codex live reasoning replaces one summary until completion exposes the complete expandable body', () => {
  const records = [
    {
      method: 'item/started',
      params: {
        item: { type: 'reasoning', id: 'reasoning_1', summary: [], content: [] },
        threadId: 'thread_1',
        turnId: 'turn_1',
        startedAtMs: 1_000
      }
    },
    {
      method: 'item/reasoning/summaryPartAdded',
      params: { threadId: 'thread_1', turnId: 'turn_1', itemId: 'reasoning_1', summaryIndex: 0 }
    },
    {
      method: 'item/reasoning/summaryTextDelta',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_1',
        itemId: 'reasoning_1',
        summaryIndex: 0,
        delta: '**Plan A**'
      }
    },
    {
      method: 'item/reasoning/summaryPartAdded',
      params: { threadId: 'thread_1', turnId: 'turn_1', itemId: 'reasoning_1', summaryIndex: 1 }
    },
    {
      method: 'item/reasoning/summaryTextDelta',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_1',
        itemId: 'reasoning_1',
        summaryIndex: 1,
        delta: '**Plan B**'
      }
    },
    {
      method: 'item/completed',
      params: {
        item: { type: 'reasoning', id: 'reasoning_1', summary: ['**Plan A**', '**Plan B**'], content: [] },
        threadId: 'thread_1',
        turnId: 'turn_1',
        completedAtMs: 7_600
      }
    }
  ];

  expect(
    records.map((_, index) => {
      const reasoning = meshAgentNeutralStreamItems({
        id: 'mesh_codex0000000',
        provider: 'codex',
        mode: 'live',
        output: records
          .slice(0, index + 1)
          .map((record) => JSON.stringify(record))
          .join('\n')
      }).filter((event) => event.kind === 'reasoning');
      return reasoning.map(({ durationMs, hasContent, streaming, summary, text }) => ({
        durationMs,
        hasContent,
        streaming,
        summary,
        text
      }));
    })
  ).toEqual([
    [{ durationMs: undefined, hasContent: false, streaming: true, summary: undefined, text: 'Thinking…' }],
    [{ durationMs: undefined, hasContent: false, streaming: true, summary: undefined, text: 'Thinking…' }],
    [{ durationMs: undefined, hasContent: false, streaming: true, summary: '**Plan A**', text: 'Thinking…' }],
    [{ durationMs: undefined, hasContent: false, streaming: true, summary: '**Plan A**', text: 'Thinking…' }],
    [{ durationMs: undefined, hasContent: false, streaming: true, summary: '**Plan B**', text: 'Thinking…' }],
    [
      {
        durationMs: 6_600,
        hasContent: undefined,
        streaming: false,
        summary: undefined,
        text: '**Plan A**\n\n**Plan B**'
      }
    ]
  ]);
});

test('Codex item lifecycle marks an unpaired tool running until its completion notification', () => {
  const records = [
    {
      method: 'item/started',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_1',
        item: {
          id: 'tool_1',
          type: 'mcpToolCall',
          server: 'example',
          tool: 'inspect',
          status: 'inProgress',
          arguments: { id: 1 }
        }
      }
    },
    {
      method: 'item/completed',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_1',
        item: {
          id: 'tool_1',
          type: 'mcpToolCall',
          server: 'example',
          tool: 'inspect',
          status: 'completed',
          arguments: { id: 1 }
        }
      }
    }
  ];
  const project = (count: number) => {
    const events = meshAgentNeutralStreamItems({
      id: 'mesh_codex0000000',
      provider: 'codex',
      mode: 'live',
      output: records
        .slice(0, count)
        .map((record) => JSON.stringify(record))
        .join('\n')
    });
    const card = cardsFromNeutral(events, 'codex')[0];
    return {
      events: events.map(({ kind, streaming, tool }) => ({ kind, streaming, tool })),
      card: card ? { kind: card.kind, streaming: card.streaming } : undefined
    };
  };

  expect({ started: project(1), completed: project(2) }).toEqual({
    started: {
      events: [
        {
          kind: 'tool-call',
          streaming: false,
          tool: { callId: 'tool_1', input: { id: 1 }, name: 'inspect', status: 'running' }
        }
      ],
      card: { kind: 'tool', streaming: true }
    },
    completed: {
      events: [
        {
          kind: 'tool-call',
          streaming: false,
          tool: { callId: 'tool_1', input: { id: 1 }, name: 'inspect', status: 'completed' }
        }
      ],
      card: { kind: 'tool', streaming: false }
    }
  });
});

test('Codex app-server observation groups one user message item lifecycle into one card', () => {
  const records = [
    {
      method: 'item/started',
      params: {
        item: {
          type: 'userMessage',
          id: 'user_1',
          content: [{ type: 'text', text: 'You have just joined this Workplace Project.' }]
        },
        threadId: 'thread_1',
        turnId: 'turn_1',
        startedAtMs: 1
      }
    },
    {
      method: 'item/completed',
      params: {
        item: {
          type: 'userMessage',
          id: 'user_1',
          content: [
            { type: 'text', text: 'You have just joined this Workplace Project.' },
            { type: 'text', text: '\nUse project_post for the public status message.' }
          ]
        },
        threadId: 'thread_1',
        turnId: 'turn_1',
        completedAtMs: 2
      }
    }
  ];
  const rawLines = records.map((record) => JSON.stringify(record));
  const output = rawLines.join('\n');

  const items = meshAgentStreamItems({ id: 'mesh_codex0000000', provider: 'codex', output });

  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    role: 'user',
    source: 'codex-app-server',
    providerEventType: 'item/userMessage',
    text: 'You have just joined this Workplace Project.\nUse project_post for the public status message.'
  });
  expect(items[0]?.provenance.rawEvents).toEqual(records);
  expect(rawJsonText(items[0]?.provenance.rawEvents)).toBe(output);
});

test('Codex app-server observation expands batch item envelopes', () => {
  const output = JSON.stringify({
    id: '019f310e-5620-7ca3-aa16-cbf41828fe60',
    items: [
      {
        type: 'userMessage',
        id: 'item-206',
        content: [{ type: 'text', text: 'New Workplace Project message is available.' }]
      },
      {
        type: 'agentMessage',
        id: 'item-207',
        text: 'I will check the project inbox now.'
      }
    ]
  });

  const items = meshAgentStreamItems({ id: 'mesh_codex0000000', provider: 'codex', output });

  expect(items.map((item) => ({ role: item.role, type: item.providerEventType, text: item.text }))).toEqual([
    {
      role: 'user',
      type: 'item/userMessage',
      text: 'New Workplace Project message is available.'
    },
    {
      role: 'agent',
      type: 'item/agentMessage',
      text: 'I will check the project inbox now.'
    }
  ]);
});

test('Codex app-server observation renders user message lifecycle as a shared message card', () => {
  const output = [
    JSON.stringify({
      method: 'item/started',
      params: {
        item: {
          type: 'userMessage',
          id: 'user_1',
          content: [{ type: 'text', text: 'You have just joined this Workplace Project.' }]
        },
        threadId: 'thread_1',
        turnId: 'turn_1',
        startedAtMs: 1
      }
    }),
    JSON.stringify({
      method: 'item/completed',
      params: {
        item: {
          type: 'userMessage',
          id: 'user_1',
          content: [
            { type: 'text', text: 'You have just joined this Workplace Project.' },
            { type: 'text', text: '\nUse project_post for the public status message.' }
          ]
        },
        threadId: 'thread_1',
        turnId: 'turn_1',
        completedAtMs: 2
      }
    })
  ].join('\n');
  const entries = renderTimeline(meshAgentStreamItems({ id: 'mesh_codex0000000', provider: 'codex', output }));

  expect(
    entries.map((entry) =>
      entry.kind === 'public'
        ? {
            kind: entry.card.kind,
            role: cardEventPayload(entry.card)?.kind === 'user-message' ? 'user' : 'agent',
            text: cardEventPayload(entry.card)?.text
          }
        : { kind: entry.kind }
    )
  ).toEqual([
    {
      kind: 'message',
      role: 'user',
      text: 'You have just joined this Workplace Project.\nUse project_post for the public status message.'
    }
  ]);
});

test('Codex app-server observation keeps a lone chunk raw record unwrapped', () => {
  const record = { method: 'item/agentMessage/delta', params: { delta: 'solo' } };

  const items = meshAgentStreamItems({ id: 'mesh_codex0000000', provider: 'codex', output: JSON.stringify(record) });

  expect(items).toHaveLength(1);
  expect(items[0]?.provenance.rawEvents).toEqual([record]);
});

test('Codex MCP startup status stays unknown instead of becoming a tool call', () => {
  const raw = {
    method: 'mcpServer/startupStatus/updated',
    params: {
      threadId: 'thread_1',
      name: 'codex-security',
      status: 'ready',
      error: null
    }
  };

  expect(
    meshAgentNeutralStreamItems({ id: 'mesh_codex0000000', provider: 'codex', output: JSON.stringify(raw) }).map(
      neutralSnapshot
    )
  ).toEqual([
    {
      id: 'mesh_codex0000000:json:0:mcp-status',
      kind: 'unknown',
      streaming: false,
      text: 'codex-security ready',
      rawEvents: [raw]
    }
  ]);
});

test('chat timeline groups consecutive Codex MCP startup statuses and keeps each server latest state', () => {
  const securityStarting = {
    method: 'mcpServer/startupStatus/updated',
    params: { name: 'codex-security', status: 'starting', error: null }
  };
  const nodeReady = {
    method: 'mcpServer/startupStatus/updated',
    params: { name: 'node_repl', status: 'ready', error: null }
  };
  const securityReady = {
    method: 'mcpServer/startupStatus/updated',
    params: { name: 'codex-security', status: 'ready', error: null }
  };
  const items: AgentObservationEvent[] = [securityStarting, nodeReady, securityReady].map((raw, index) => ({
    id: `startup_${index}`,
    kind: 'unknown',
    streaming: false,
    text: `${raw.params.name} ${raw.params.status}`,
    provenance: { contractEvents: [raw] },
    at: `2026-07-18T10:00:0${index}.000Z`
  }));

  const entries = observationTimelineEntries(cardsFromNeutral(items, 'codex'), 'codex');
  expect(entries).toMatchObject([
    {
      kind: 'public',
      card: {
        kind: 'codex-mcp-startup-progress',
        payload: {
          updates: [
            { name: 'codex-security', status: 'ready' },
            { name: 'node_repl', status: 'ready' }
          ]
        }
      }
    }
  ]);
  expect(observationContractRawEvents(entries[0]?.contractEvents ?? [])).toEqual([
    securityStarting,
    nodeReady,
    securityReady
  ]);
});

test('chat timeline recognizes Codex MCP startup raw records after legacy system normalization', () => {
  const raw = {
    method: 'mcpServer/startupStatus/updated',
    params: {
      threadId: '019f6b1f-a60e-7d82-9dd0-3f6dfbc46e5a',
      name: 'codex_apps',
      status: 'ready',
      error: null,
      failureReason: null
    }
  };

  expect(
    observationTimelineEntries(
      cardsFromNeutral(
        [
          {
            id: 'legacy-startup',
            kind: 'system',
            streaming: false,
            text: 'codex_apps ready',
            provenance: { contractEvents: [raw] }
          }
        ],
        'mesh-agent'
      ),
      'mesh-agent'
    )
  ).toEqual([
    {
      id: 'codex-mcp-startup:legacy-startup',
      kind: 'public',
      card: {
        id: 'codex-mcp-startup:legacy-startup',
        kind: 'codex-mcp-startup-progress',
        streaming: false,
        payload: { updates: [{ name: 'codex_apps', status: 'ready' }] },
        provenance: { contractEvents: [raw] }
      },
      contractEvents: [raw]
    }
  ]);
});

test('chat timeline splits Codex startup groups around ordinary messages', () => {
  const startup = (id: string, params: Record<string, unknown>): AgentObservationEvent => ({
    id,
    kind: 'unknown',
    streaming: false,
    text: id,
    provenance: { contractEvents: [{ method: 'mcpServer/startupStatus/updated', params }] }
  });
  const entries = observationTimelineEntries(
    cardsFromNeutral(
      [
        startup('first', { name: 'codex-security', status: 'failed', error: 'timeout' }),
        {
          id: 'message',
          kind: 'assistant-message',
          streaming: false,
          text: 'Continuing.',
          provenance: { contractEvents: [{ type: 'assistant', text: 'Continuing.' }] }
        },
        startup('second', {})
      ],
      'codex'
    ),
    'codex'
  );
  expect(entries.map((entry) => (entry.kind === 'public' ? entry.card.kind : entry.kind))).toEqual([
    'codex-mcp-startup-progress',
    'message',
    'codex-mcp-startup-progress'
  ]);
  expect(
    entries.flatMap((entry) =>
      entry.kind === 'public' && entry.card.kind === 'codex-mcp-startup-progress' ? [entry.card.payload.updates] : []
    )
  ).toEqual([
    [{ error: 'timeout', name: 'codex-security', status: 'failed' }],
    [{ name: 'unknown', status: 'updated' }]
  ]);
});

test('Codex app-server observation concatenates deltas verbatim without injecting spaces', () => {
  const output = [
    JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'impl' } }),
    JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'ementation' } })
  ].join('\n');

  expect(meshAgentStreamItems({ id: 'mesh_codex0000000', provider: 'codex', output }).map((item) => item.text)).toEqual(
    ['implementation']
  );
});

test('Codex app-server observation does not insert spaces between CJK deltas', () => {
  const output = [
    JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: '我来' } }),
    JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: '先做大文件' } }),
    JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: '盘点' } })
  ].join('\n');

  expect(meshAgentStreamItems({ id: 'mesh_codex0000000', provider: 'codex', output }).map((item) => item.text)).toEqual(
    ['我来先做大文件盘点']
  );
});

test('Codex app-server observation keeps codex-sent whitespace across clause punctuation', () => {
  const output = [
    JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'already gone;' } }),
    JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: ' I am checking now.' } }),
    JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: ' Two branches remain.' } })
  ].join('\n');

  expect(meshAgentStreamItems({ id: 'mesh_codex0000000', provider: 'codex', output }).map((item) => item.text)).toEqual(
    ['already gone; I am checking now. Two branches remain.']
  );
});

test('Codex app-server observation keeps provider events in timeline order', () => {
  const output = [
    JSON.stringify({ method: 'mcpServer/startupStatus/updated', params: { name: 'codegraph', status: 'starting' } }),
    JSON.stringify({ id: 1, result: { turn: { id: 'turn_a', status: 'inProgress' } } }),
    JSON.stringify({ method: 'turn/started', params: {} }),
    JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'First' } }),
    JSON.stringify({ method: 'turn/completed', params: {} }),
    JSON.stringify({ id: 2, result: { turn: { id: 'turn_b', status: 'inProgress' } } }),
    JSON.stringify({ method: 'turn/started', params: {} }),
    JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'Second' } }),
    JSON.stringify({ method: 'turn/completed', params: {} })
  ].join('\n');

  const items = meshAgentStreamItems({ id: 'mesh_codex0000000', provider: 'codex', output });

  expect(items.map((item) => item.text)).toEqual([
    'codegraph starting',
    '{"id":1,"result":{"turn":{"id":"turn_a","status":"inProgress"}}}',
    'turn/started',
    'First',
    'turn/completed',
    '{"id":2,"result":{"turn":{"id":"turn_b","status":"inProgress"}}}',
    'turn/started',
    'Second',
    'turn/completed'
  ]);
  expect(items.map((item) => item.source)).toEqual([
    'codex-app-server',
    'unknown',
    'codex-app-server',
    'codex-app-server',
    'codex-app-server',
    'unknown',
    'codex-app-server',
    'codex-app-server',
    'codex-app-server'
  ]);
});

test('observation preserves identical provider messages with different identities', () => {
  const output = [
    JSON.stringify({
      type: 'assistant',
      uuid: 'message-1',
      message: { content: [{ type: 'text', text: 'Same answer' }] }
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'message-2',
      message: { content: [{ type: 'text', text: 'Same answer' }] }
    })
  ].join('\n');

  expect(
    meshAgentStreamItems({ id: 'mesh_claude000000', provider: 'claude-code', output }).map((item) => ({
      rawEvents: item.provenance.rawEvents,
      text: item.text
    }))
  ).toEqual([
    {
      rawEvents: [
        {
          type: 'assistant',
          uuid: 'message-1',
          message: { content: [{ type: 'text', text: 'Same answer' }] }
        }
      ],
      text: 'Same answer'
    },
    {
      rawEvents: [
        {
          type: 'assistant',
          uuid: 'message-2',
          message: { content: [{ type: 'text', text: 'Same answer' }] }
        }
      ],
      text: 'Same answer'
    }
  ]);
});

test('Codex app-server observation projects raw response tool calls and results', () => {
  const output = [
    JSON.stringify({
      method: 'rawResponseItem/completed',
      params: {
        item: {
          type: 'function_call',
          name: 'Bash',
          call_id: 'call_1',
          arguments: JSON.stringify({ command: 'git status', description: 'Check status' })
        }
      }
    }),
    JSON.stringify({
      method: 'rawResponseItem/completed',
      params: {
        item: {
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'On branch main'
        }
      }
    })
  ].join('\n');

  const items = meshAgentStreamItems({ id: 'mesh_codex0000000', provider: 'codex', output });

  expect(items.map((item) => ({ role: item.role, type: item.providerEventType, text: item.text }))).toEqual([
    {
      role: 'tool',
      type: 'function_call',
      text: 'Tool call Bash {"command":"git status","description":"Check status"}'
    },
    { role: 'tool', type: 'function_call_output', text: 'On branch main' }
  ]);
});

test('Codex raw response tool call and output pair into one command timeline card by call id', () => {
  const output = [
    JSON.stringify({
      method: 'rawResponseItem/completed',
      params: {
        item: {
          type: 'function_call',
          name: 'Bash',
          call_id: 'call_pair_1',
          arguments: JSON.stringify({ command: 'git status' })
        }
      }
    }),
    JSON.stringify({
      method: 'rawResponseItem/completed',
      params: {
        item: {
          type: 'function_call_output',
          call_id: 'call_pair_1',
          output: 'On branch main'
        }
      }
    })
  ].join('\n');

  const entries = observationTimelineEntries(
    cardsFromNeutral(meshAgentNeutralStreamItems({ id: 'mesh_codex0000000', provider: 'codex', output }), 'codex'),
    'codex'
  );

  expect(
    entries.map((entry) =>
      entry.kind === 'public' && entry.card.kind === 'tool'
        ? {
            type: entry.card.kind,
            command: cardToolCallPayload(entry.card)?.tool?.input,
            output: cardToolResultPayload(entry.card)?.tool?.output,
            rawEvents: observationContractRawEvents(entry.contractEvents)
          }
        : { type: entry.kind }
    )
  ).toEqual([
    {
      type: 'tool',
      command: '{"command":"git status"}',
      output: 'On branch main',
      rawEvents: [
        {
          method: 'rawResponseItem/completed',
          params: {
            item: {
              type: 'function_call',
              name: 'Bash',
              call_id: 'call_pair_1',
              arguments: '{"command":"git status"}'
            }
          }
        },
        {
          method: 'rawResponseItem/completed',
          params: {
            item: {
              type: 'function_call_output',
              call_id: 'call_pair_1',
              output: 'On branch main'
            }
          }
        }
      ]
    }
  ]);
});

test('Codex turns page history projects explicit turn boundaries around each returned turn', () => {
  const output = JSON.stringify({
    result: {
      data: [
        {
          id: 'turn_1',
          startedAtMs: 1_784_000_000_000,
          completedAtMs: 1_784_000_005_000,
          items: [{ type: 'agentMessage', id: 'msg_1', text: 'first turn answer' }]
        },
        {
          id: 'turn_2',
          startedAtMs: 1_784_000_010_000,
          completedAtMs: 1_784_000_015_000,
          items: [{ type: 'agentMessage', id: 'msg_2', text: 'second turn answer' }]
        }
      ]
    }
  });

  const items = meshAgentNeutralStreamItems({ id: 'mesh_codex0000000', provider: 'codex', output });

  expect(items.map(({ at, kind, reason, text }) => ({ at, kind, reason, text }))).toEqual([
    { at: '2026-07-14T03:33:20.000Z', kind: 'turn-start', reason: undefined, text: 'Turn started' },
    { at: '2026-07-14T03:33:25.000Z', kind: 'assistant-message', reason: undefined, text: 'first turn answer' },
    { at: '2026-07-14T03:33:25.000Z', kind: 'turn-end', reason: 'completed', text: 'Turn completed' },
    { at: '2026-07-14T03:33:30.000Z', kind: 'turn-start', reason: undefined, text: 'Turn started' },
    { at: '2026-07-14T03:33:35.000Z', kind: 'assistant-message', reason: undefined, text: 'second turn answer' },
    { at: '2026-07-14T03:33:35.000Z', kind: 'turn-end', reason: 'completed', text: 'Turn completed' }
  ]);
});

test('Codex app-server observation projects item tool lifecycle and output deltas', () => {
  const output = [
    JSON.stringify({
      method: 'item/started',
      params: {
        item: {
          type: 'commandExecution',
          command: 'bun test'
        }
      }
    }),
    JSON.stringify({
      method: 'item/commandExecution/outputDelta',
      params: { delta: 'running' }
    }),
    JSON.stringify({
      method: 'item/commandExecution/outputDelta',
      params: { delta: ' tests' }
    }),
    JSON.stringify({
      method: 'item/completed',
      params: {
        item: {
          type: 'commandExecution',
          output: 'ok'
        }
      }
    })
  ].join('\n');

  const items = meshAgentStreamItems({ id: 'mesh_codex0000000', provider: 'codex', output });

  expect(items.map((item) => ({ role: item.role, type: item.providerEventType, text: item.text }))).toEqual([
    { role: 'tool', type: 'function_call', text: 'Tool call commandExecution bun test' },
    { role: 'tool', type: 'item/commandExecution/outputDelta', text: 'running tests' },
    { role: 'tool', type: 'function_call_output', text: 'ok' }
  ]);
});

test('Codex app-server observation folds a command lifecycle into one ordered tool card', () => {
  const records = [
    {
      method: 'item/started',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_1',
        item: {
          id: 'item_1',
          type: 'command_execution',
          command: 'bun test',
          aggregated_output: '',
          exit_code: null,
          status: 'running'
        }
      }
    },
    {
      method: 'item/commandExecution/outputDelta',
      params: { threadId: 'thread_1', turnId: 'turn_1', itemId: 'item_1', delta: 'running' }
    },
    {
      method: 'item/commandExecution/outputDelta',
      params: { threadId: 'thread_1', turnId: 'turn_1', itemId: 'item_1', delta: ' tests' }
    },
    {
      method: 'item/completed',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_1',
        item: {
          id: 'item_1',
          type: 'command_execution',
          command: 'bun test',
          aggregated_output: 'running tests',
          exit_code: 0,
          status: 'completed'
        }
      }
    }
  ];

  const adapter = builtinAgentAdapters.find((candidate) => candidate.provider === 'codex');
  if (!adapter?.events) throw new Error('Expected Codex observation adapter');
  const projector = adapter.events.createLiveProjector?.({ id: 'mesh_codex0000000' });
  if (!projector) throw new Error('Expected Codex live observation projector');
  let projected: MeshAgentObservationEvent[] = [];
  for (const record of records) projected = projector.advance(`${JSON.stringify(record)}\n`).events;

  const items = projected
    .map((event) => toAgentObservationEvent(event, adapter.observation))
    .filter((event): event is AgentObservationEvent => event !== null);
  const entries = observationTimelineEntries(cardsFromNeutral(items, 'codex'), 'codex');

  expect({
    events: items.map(({ kind, tool }) => ({ kind, tool })),
    cards: entries.map((entry) =>
      entry.kind === 'public' && entry.card.kind === 'tool'
        ? {
            kind: entry.card.kind,
            call: cardToolCallPayload(entry.card)?.tool,
            result: cardToolResultPayload(entry.card)?.tool
          }
        : { kind: entry.kind }
    )
  }).toEqual({
    events: [
      {
        kind: 'tool-call',
        tool: {
          callId: 'item_1',
          category: 'shell',
          input: 'bun test',
          name: 'command_execution',
          status: 'running'
        }
      },
      {
        kind: 'tool-result',
        tool: {
          callId: 'item_1',
          category: 'shell',
          exitCode: 0,
          input: 'bun test',
          name: 'command_execution',
          output: 'running tests',
          status: 'completed'
        }
      }
    ],
    cards: [
      {
        kind: 'tool',
        call: {
          callId: 'item_1',
          category: 'shell',
          input: 'bun test',
          name: 'command_execution',
          status: 'running'
        },
        result: {
          callId: 'item_1',
          category: 'shell',
          exitCode: 0,
          input: 'bun test',
          name: 'command_execution',
          output: 'running tests',
          status: 'completed'
        }
      }
    ]
  });
});

test('Codex image generation stays running until completion and exposes the generated image preview', () => {
  const started = {
    method: 'item/started',
    params: {
      item: {
        id: 'image_1',
        type: 'imageGeneration',
        status: 'in_progress',
        revisedPrompt: null,
        result: ''
      }
    }
  };
  const completed = {
    method: 'item/completed',
    params: {
      item: {
        id: 'image_1',
        type: 'imageGeneration',
        status: 'completed',
        revisedPrompt: 'Draw a preview',
        result: 'iVBORw0KGgo=',
        savedPath: '/tmp/generated.png'
      }
    }
  };
  const project = (records: unknown[]) => {
    const events = meshAgentNeutralStreamItems({
      id: 'mesh_codex_image',
      provider: 'codex',
      mode: 'live',
      output: records.map((record) => JSON.stringify(record)).join('\n')
    });
    return { events, cards: agentObservationCards(events, 'codex') };
  };
  const running = project([started]);
  const settled = project([started, completed]);
  const settledCard = settled.cards.find((card) => card.kind === 'tool');
  if (!settledCard) throw new Error('Expected image generation tool card');
  const call = settledCard.payload.call as AgentObservationEvent | undefined;
  const result = settledCard.payload.result as AgentObservationEvent | undefined;
  const view = imageToolView(call, result, settledCard.provenance.contractEvents);

  expect({
    running: running.cards.map((card) => ({ kind: card.kind, streaming: card.streaming })),
    settled: {
      events: settled.events.map((event) => ({ kind: event.kind, status: event.tool?.status, text: event.text })),
      streaming: settledCard.streaming,
      view: view ? { ...view, imageSrc: view.imageSrc.slice(0, 26) } : null
    }
  }).toEqual({
    running: [{ kind: 'tool', streaming: true }],
    settled: {
      events: [
        { kind: 'tool-call', status: 'running', text: 'Tool call imageGeneration' },
        { kind: 'tool-result', status: 'completed', text: '/tmp/generated.png' }
      ],
      streaming: false,
      view: {
        imageSrc: 'data:image/png;base64,iVBO',
        name: 'generated.png',
        path: '/tmp/generated.png',
        sizeLabel: '8 B'
      }
    }
  });
});

test('Codex history image generation pairs the item and never renders its base64 result as generic tool text', () => {
  const imageResult = `iVBOR${'a'.repeat(300_000)}`;
  const events = meshAgentNeutralStreamItems({
    id: 'mesh_codex_image_history',
    provider: 'codex',
    mode: 'events',
    output: JSON.stringify({
      id: 'turn_image_history',
      itemsView: 'full',
      status: 'completed',
      items: [
        {
          id: 'image_history_1',
          type: 'imageGeneration',
          status: 'completed',
          revisedPrompt: 'Draw a preview',
          result: imageResult,
          savedPath: '/tmp/history-generated.png'
        }
      ]
    })
  });
  const cards = agentObservationCards(events, 'codex');
  const toolCard = cards.find((card) => card.kind === 'tool');
  if (!toolCard) throw new Error('Expected history image generation tool card');
  const call = toolCard.payload.call as AgentObservationEvent | undefined;
  const result = toolCard.payload.result as AgentObservationEvent | undefined;
  const view = imageToolView(call, result, toolCard.provenance.contractEvents);

  expect({
    cardCount: cards.filter((card) => card.kind === 'tool').length,
    callId: call?.tool?.callId,
    callInput: call?.tool?.input,
    resultCallId: result?.tool?.callId,
    resultOutput: result?.tool?.output,
    view: view
      ? {
          imagePrefix: view.imageSrc.slice(0, 26),
          name: view.name,
          path: view.path,
          sizeLabel: view.sizeLabel
        }
      : null
  }).toEqual({
    cardCount: 1,
    callId: 'image_history_1',
    callInput: 'Draw a preview',
    resultCallId: 'image_history_1',
    resultOutput: '/tmp/history-generated.png',
    view: {
      imagePrefix: 'data:image/png;base64,iVBO',
      name: 'history-generated.png',
      path: '/tmp/history-generated.png',
      sizeLabel: '220 KB'
    }
  });
});

test('Codex history file changes render as paired semantic tool cards', () => {
  const events = meshAgentNeutralStreamItems({
    id: 'mesh_codex_file_change_history',
    provider: 'codex',
    mode: 'events',
    output: JSON.stringify({
      id: 'turn_file_change_history',
      itemsView: 'full',
      status: 'completed',
      items: [
        {
          id: 'file_change_1',
          type: 'fileChange',
          status: 'completed',
          changes: [{ path: '/tmp/example.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@' }]
        }
      ]
    })
  });
  const cards = agentObservationCards(events, 'codex');
  const toolCard = cards.find((card) => card.kind === 'tool');
  if (!toolCard) throw new Error('Expected history file change tool card');
  const call = toolCard.payload.call as AgentObservationEvent | undefined;
  const result = toolCard.payload.result as AgentObservationEvent | undefined;

  expect({
    cardCount: cards.filter((card) => card.kind === 'tool').length,
    call: call?.tool,
    result: result?.tool
  }).toEqual({
    cardCount: 1,
    call: {
      callId: 'file_change_1',
      name: 'File change',
      status: 'completed'
    },
    result: {
      callId: 'file_change_1',
      name: 'File change',
      output:
        '{"id":"file_change_1","type":"fileChange","status":"completed","changes":[{"path":"/tmp/example.ts","kind":{"type":"update"},"diff":"@@ -1 +1 @@"}]}',
      status: 'completed'
    }
  });
});

test('Codex observation does not project a capped partial JSON record as one giant message', () => {
  const output = `truncated provider payload ${'x'.repeat(70_000)} \\"method\\":\\"item/completed\\"}`;

  expect(meshAgentStreamItems({ id: 'mesh_codex0000000', provider: 'codex', output })).toEqual([]);
});

test('Codex observation keeps item ids stable when older records leave the snapshot', () => {
  const completed = JSON.stringify({
    method: 'item/completed',
    params: {
      item: {
        type: 'commandExecution',
        id: 'call_stable',
        command: 'bun test',
        status: 'completed',
        aggregatedOutput: 'pass'
      }
    }
  });
  const first = meshAgentStreamItems({
    id: 'mesh_codex0000000',
    provider: 'codex',
    output: [JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread_1' } }), completed].join(
      '\n'
    )
  });
  const shifted = meshAgentStreamItems({ id: 'mesh_codex0000000', provider: 'codex', output: completed });

  expect(first.filter((item) => item.role === 'tool').map((item) => item.id)).toEqual(
    shifted.filter((item) => item.role === 'tool').map((item) => item.id)
  );
});

test('Codex app-server observation projects completed MCP tool calls with arguments and result', () => {
  const raw = {
    method: 'item/completed',
    params: {
      item: {
        type: 'mcpToolCall',
        id: 'call_1',
        server: 'codegraph',
        tool: 'codegraph_explore',
        status: 'completed',
        arguments: {
          projectPath: '/private/tmp/monad-a2a-agent',
          query: 'apps/web MeshAgent settings',
          maxFiles: 8
        },
        result: {
          content: [{ type: 'text', text: 'Found 209 symbols across 91 files.' }],
          structuredContent: null,
          error: null,
          durationMs: 232
        }
      }
    }
  };
  const output = JSON.stringify(raw);

  const items = meshAgentStreamItems({ id: 'mesh_codex0000000', provider: 'codex', output });

  expect(items.map((item) => ({ role: item.role, type: item.providerEventType, text: item.text }))).toEqual([
    {
      role: 'tool',
      type: 'function_call',
      text: 'Tool call codegraph_explore {"projectPath":"/private/tmp/monad-a2a-agent","query":"apps/web MeshAgent settings","maxFiles":8}'
    },
    {
      role: 'tool',
      type: 'function_call_output',
      text: 'Found 209 symbols across 91 files.'
    }
  ]);

  expect(
    renderTimeline(items).map((entry) => ({
      type: entry.kind === 'public' ? entry.card.kind : entry.card.type,
      rawEvents: observationContractRawEvents(entry.contractEvents)
    }))
  ).toEqual([{ type: 'tool', rawEvents: [raw] }]);
});

test('Codex app-server observation collapses repeated MCP completion records by item id', () => {
  const completed = {
    method: 'item/completed',
    params: {
      item: {
        id: 'item_3',
        type: 'mcpToolCall',
        server: 'monad',
        tool: 'project_read',
        arguments: { around: 'msg_AQH6i9hsntAy', limit: 80 },
        result: null,
        error: {
          message:
            'tool call error: tool call failed for `monad/project_read`\n\nCaused by:\n    timed out awaiting tools/call after 300s'
        },
        status: 'failed'
      }
    }
  };
  const output = [JSON.stringify(completed), JSON.stringify(completed)].join('\n');

  const items = meshAgentStreamItems({ id: 'mesh_codex0000000', provider: 'codex', output });

  expect(items.map((item) => ({ role: item.role, type: item.providerEventType, text: item.text }))).toEqual([
    {
      role: 'tool',
      type: 'function_call',
      text: 'Tool call project_read {"around":"msg_AQH6i9hsntAy","limit":80}'
    },
    {
      role: 'tool',
      type: 'function_call_output',
      text: JSON.stringify(completed.params.item)
    }
  ]);
  expect(renderTimeline(items).map((entry) => (entry.kind === 'public' ? entry.card.kind : entry.card.type))).toEqual([
    'tool'
  ]);
});

test('Codex app-server observation projects turns page responses', () => {
  const output = JSON.stringify({
    id: 17,
    result: {
      data: [
        {
          id: 'turn_1',
          items: [
            { type: 'userMessage', id: 'item_1', text: 'Inspect MeshAgent settings' },
            {
              type: 'mcpToolCall',
              id: 'call_1',
              server: 'codegraph',
              tool: 'codegraph_explore',
              status: 'completed',
              arguments: { query: 'MeshAgent settings', maxFiles: 4 },
              result: { content: [{ type: 'text', text: 'Found settings code.' }] }
            },
            { type: 'agentMessage', id: 'item_2', text: 'The settings form owns this surface.' }
          ],
          itemsView: 'full',
          status: 'completed'
        }
      ],
      nextCursor: null,
      backwardsCursor: null
    }
  });

  const items = meshAgentStreamItems({ id: 'mesh_codex0000000', provider: 'codex', output });

  expect(items.map((item) => ({ role: item.role, type: item.providerEventType, text: item.text }))).toEqual([
    { role: 'system', type: 'turn-start', text: 'Turn started' },
    { role: 'user', type: 'item/userMessage', text: 'Inspect MeshAgent settings' },
    {
      role: 'tool',
      type: 'function_call',
      text: 'Tool call codegraph_explore {"query":"MeshAgent settings","maxFiles":4}'
    },
    {
      role: 'tool',
      type: 'function_call_output',
      text: 'Found settings code.'
    },
    { role: 'agent', type: 'item/agentMessage', text: 'The settings form owns this surface.' },
    { role: 'system', type: 'turn-end', text: 'Turn completed' }
  ]);
  expect(renderTimeline(items).map((entry) => (entry.kind === 'public' ? entry.card.kind : entry.card.type))).toEqual([
    'turn',
    'message',
    'tool',
    'message',
    'turn'
  ]);
});

test('Codex app-server full turn reasoning projects each summary as a separate item', () => {
  const output = JSON.stringify({
    id: 'turn_with_summary',
    items: [
      {
        type: 'reasoning',
        id: 'item_reasoning',
        summary: ['**Enumerating MCP tools by server grouping**', '**Checking tool availability**'],
        content: []
      }
    ],
    itemsView: 'full',
    status: 'completed',
    startedAt: 1_786_250_334,
    completedAt: 1_786_250_362
  });

  expect(
    meshAgentNeutralStreamItems({ id: 'mesh_codex0000000', provider: 'codex', output }).map(
      ({ hasContent, kind, summary, text }) => ({ hasContent, kind, summary, text })
    )
  ).toEqual([
    { hasContent: undefined, kind: 'turn-start', summary: undefined, text: 'Turn started' },
    {
      hasContent: false,
      kind: 'reasoning',
      summary: '**Enumerating MCP tools by server grouping**',
      text: 'Thinking…'
    },
    {
      hasContent: false,
      kind: 'reasoning',
      summary: '**Checking tool availability**',
      text: 'Thinking…'
    },
    { hasContent: undefined, kind: 'turn-end', summary: undefined, text: 'Turn completed' }
  ]);
});

test('Codex app-server observation projects web search and compaction items', () => {
  const output = [
    JSON.stringify({
      method: 'item/completed',
      params: {
        item: {
          type: 'webSearch',
          id: 'ws_1',
          query: 'react-native-libsodium GitHub crypto_kx',
          results: [
            {
              title: 'react-native-libsodium',
              url: 'https://github.com/example/react-native-libsodium'
            }
          ],
          action: {
            type: 'search',
            query: 'react-native-libsodium GitHub crypto_kx',
            queries: null
          }
        }
      }
    }),
    JSON.stringify({
      method: 'item/completed',
      params: {
        item: {
          type: 'contextCompaction',
          id: 'item-250'
        }
      }
    })
  ].join('\n');

  expect(meshAgentStreamItems({ id: 'mesh_codex0000000', provider: 'codex', output })).toMatchObject([
    {
      role: 'tool',
      source: 'codex-app-server',
      providerEventType: 'function_call',
      text: 'Tool call Search {"type":"search","query":"react-native-libsodium GitHub crypto_kx","queries":null}'
    },
    {
      role: 'tool',
      source: 'codex-app-server',
      providerEventType: 'function_call_output',
      text: '[{"title":"react-native-libsodium","url":"https://github.com/example/react-native-libsodium"}]'
    },
    {
      role: 'system',
      source: 'codex-app-server',
      providerEventType: 'contextCompaction',
      text: 'Context compacted'
    }
  ]);
  const neutralEvents = meshAgentNeutralStreamItems({ id: 'mesh_codex0000000', provider: 'codex', output });
  expect(
    neutralEvents.map((event) => ({
      kind: event.kind,
      text: event.text
    }))
  ).toEqual([
    {
      kind: 'tool-call',
      text: 'Tool call Search {"type":"search","query":"react-native-libsodium GitHub crypto_kx","queries":null}'
    },
    {
      kind: 'tool-result',
      text: '[{"title":"react-native-libsodium","url":"https://github.com/example/react-native-libsodium"}]'
    },
    { kind: 'context-compaction', text: 'Context compacted' }
  ]);
  expect(
    agentObservationCards(neutralEvents, 'codex')
      .filter((card) => card.kind === 'tool')
      .map((card) => ({
        name: cardToolCallPayload(card)?.tool?.name,
        output: cardToolResultPayload(card)?.tool?.output
      }))
  ).toEqual([
    {
      name: 'Search',
      output: [
        {
          title: 'react-native-libsodium',
          url: 'https://github.com/example/react-native-libsodium'
        }
      ]
    }
  ]);
});

test('Codex app-server observation recovers every generic tool name from its semantic input', () => {
  const events = meshAgentNeutralStreamItems({
    id: 'mesh_codex_generic_tools',
    provider: 'codex',
    output: JSON.stringify({
      method: 'item/completed',
      params: {
        item: {
          type: 'tool',
          id: 'tool_fetch_1',
          input: { type: 'fetch_page', url: 'https://example.com' },
          output: 'Fetched page.'
        }
      }
    })
  });

  expect(
    agentObservationCards(events, 'codex').map((card) => ({
      callId: cardToolCallPayload(card)?.tool?.callId,
      input: cardToolCallPayload(card)?.tool?.input,
      kind: card.kind,
      name: cardToolCallPayload(card)?.tool?.name,
      output: cardToolResultPayload(card)?.tool?.output
    }))
  ).toEqual([
    {
      callId: 'tool_fetch_1',
      input: { type: 'fetch_page', url: 'https://example.com' },
      kind: 'tool',
      name: 'Fetch Page',
      output: 'Fetched page.'
    }
  ]);
});

test('Codex app-server observation projects a bare context compaction item', () => {
  const record = { type: 'contextCompaction', id: 'item-785' };

  expect(
    meshAgentNeutralStreamItems({
      id: 'mesh_codex_compact',
      provider: 'codex',
      output: JSON.stringify(record)
    })
  ).toEqual([
    {
      id: 'mesh_codex_compact:json:0:context-compaction',
      kind: 'context-compaction',
      streaming: false,
      text: 'Context compacted',
      provenance: {
        contractEvents: [
          {
            id: 'mesh_codex_compact:json:0:context-compaction',
            role: 'system',
            text: 'Context compacted',
            source: 'codex-app-server',
            providerEventType: 'contextCompaction',
            provenance: { rawEvents: [record] }
          }
        ]
      }
    }
  ]);
});

test('Claude Code observation projects the SDK compact boundary as context compaction', () => {
  const record = {
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: {
      trigger: 'auto',
      pre_tokens: 152_430,
      post_tokens: 31_204,
      duration_ms: 842
    },
    uuid: 'claude-compact-1',
    session_id: 'claude-session-1'
  };

  expect(
    meshAgentNeutralStreamItems({
      id: 'mesh_claude_compact',
      provider: 'claude-code',
      output: JSON.stringify(record)
    })
  ).toEqual([
    {
      id: 'claude-compact-1:context-compaction',
      kind: 'context-compaction',
      streaming: false,
      text: 'Context compacted',
      provenance: {
        contractEvents: [
          {
            id: 'claude-compact-1:context-compaction',
            role: 'system',
            text: 'Context compacted',
            source: 'claude-code-sdk',
            providerEventType: 'compact_boundary',
            provenance: { rawEvents: [record] }
          }
        ]
      }
    }
  ]);
});

test('Codex app-server usage meter reads rate limit updates', () => {
  const output = JSON.stringify({
    method: 'account/rateLimits/updated',
    params: {
      rateLimits: {
        primary: { usedPercent: 6, windowDurationMins: 300, resetsAt: 1_782_935_600_000 },
        secondary: { usedPercent: 25, windowDurationMins: 10_080, resetsAt: 1_783_022_400_000 }
      }
    }
  });

  expect(meshAgentUsageLimitMeter({ provider: 'codex', output })).toMatchObject({
    title: 'Usage remaining',
    rows: [
      { id: 'primary', label: '5-hour limit', percent: 94 },
      { id: 'secondary', label: 'Weekly · all models', percent: 75 }
    ]
  });
  expect(meshAgentStreamItems({ id: 'mesh_codex0000000', provider: 'codex', output }).map((item) => item.text)).toEqual(
    ['Usage limits updated']
  );
});

test('Codex app-server usage meter reads token usage updates', () => {
  const output = JSON.stringify({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: '019f2764-c789-7953-a385-b5c788908861',
      turnId: '019f2810-2ef8-7170-8188-414204408604',
      tokenUsage: {
        total: {
          totalTokens: 1_029_307,
          inputTokens: 1_024_270,
          cachedInputTokens: 835_968,
          outputTokens: 5_037,
          reasoningOutputTokens: 1_205
        },
        last: {
          totalTokens: 68_235,
          inputTokens: 68_141,
          cachedInputTokens: 67_456,
          outputTokens: 94,
          reasoningOutputTokens: 0
        },
        modelContextWindow: 258_400
      }
    }
  });

  expect(meshAgentUsageLimitMeter({ provider: 'codex', output })).toMatchObject({
    title: 'Token usage',
    rows: [
      { id: 'last_turn', label: 'Last turn', percent: 26, meterPercent: 26 },
      { id: 'thread_total', label: 'Thread total', percent: 398, meterPercent: 100 }
    ]
  });
  expect(meshAgentStreamItems({ id: 'mesh_codex0000000', provider: 'codex', output }).map((item) => item.text)).toEqual(
    ['Token usage updated']
  );
});

test('Claude Code usage meter reads rate limit events', () => {
  const output = [
    JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { rateLimitType: 'five_hour', utilization: 74, resetsAt: 1_782_935_600_000 }
    }),
    JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { rateLimitType: 'seven_day', utilization: 31, resetsAt: 1_783_022_400_000 }
    })
  ].join('\n');

  expect(meshAgentUsageLimitMeter({ provider: 'claude-code', output })).toMatchObject({
    title: 'Usage remaining',
    rows: [
      { id: 'five_hour', label: '5h', percent: 26 },
      { id: 'seven_day', label: 'Weekly', percent: 69 }
    ]
  });
});

test('Claude Code observation projects rate limit events without raw cards', () => {
  const output = JSON.stringify({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed',
      resetsAt: 1_783_248_000,
      rateLimitType: 'five_hour',
      usedPercent: 42
    },
    uuid: 'rate_1',
    session_id: 'claude-session'
  });

  expect(meshAgentStreamItems({ id: 'mesh_claude000000', provider: 'claude-code', output })).toMatchObject([
    {
      role: 'system',
      source: 'claude-code-sdk',
      providerEventType: 'rate_limit_event',
      text: 'Usage limits updated'
    }
  ]);
});

test('Claude Code usage meter reads status-only rate limit events', () => {
  const output = JSON.stringify({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed',
      resetsAt: 1_783_248_000,
      rateLimitType: 'five_hour',
      overageStatus: 'allowed',
      overageResetsAt: 1_783_236_600,
      isUsingOverage: false
    },
    uuid: '421238d3-0cab-4345-b147-27eb1bcf8f5d',
    session_id: 'baa34689-e0c7-44a1-b60d-2afc2cc7a971'
  });

  expect(meshAgentUsageLimitMeter({ provider: 'claude-code', output })).toMatchObject({
    title: 'Usage remaining',
    rows: [{ id: 'five_hour', label: '5h', percent: 100 }]
  });
});

test('non-Claude providers do not parse Claude rate limit events by field shape', () => {
  const output = JSON.stringify({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed',
      resetsAt: 1_783_248_000,
      rateLimitType: 'five_hour'
    }
  });
  expect(meshAgentUsageLimitMeter({ provider: 'codex', output })).toBeNull();
});

test('Claude Code observation projects transcript user events as user message cards', () => {
  const output = JSON.stringify({
    parentUuid: '8c04922a-bbb2-4a25-a71c-8fdc0154f58e',
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'New Workplace Project message is available.'
        }
      ]
    },
    uuid: '21dace30-5217-4a5c-a48c-7f4b86f4e85d',
    timestamp: '2026-07-05T08:07:54.056Z'
  });
  const entries = renderTimeline(meshAgentStreamItems({ id: 'mesh_claude000000', provider: 'claude-code', output }));

  expect(
    entries.map((entry) =>
      entry.kind === 'public' && entry.card.kind === 'message'
        ? {
            kind: cardEventPayload(entry.card)?.kind,
            role: cardEventPayload(entry.card)?.kind === 'user-message' ? 'user' : 'agent',
            text: cardEventPayload(entry.card)?.text,
            type: entry.card.kind
          }
        : { kind: entry.kind, type: entry.kind === 'public' ? entry.card.kind : entry.card.type }
    )
  ).toEqual([
    { kind: 'public', type: 'turn' },
    {
      kind: 'user-message',
      role: 'user',
      text: 'New Workplace Project message is available.',
      type: 'message'
    }
  ]);
});

test('Codex app-server observation renders a standalone commandExecution result as a command card', () => {
  const raw = {
    method: 'item/completed',
    params: {
      item: {
        type: 'commandExecution',
        id: 'call_1',
        command: 'git status --short',
        cwd: '/tmp/project-agent',
        status: 'completed',
        aggregatedOutput: '{"messages":[{"text":"ok"}]}'
      }
    }
  };
  const entries = renderTimeline([
    {
      id: 'mesh_codex0000000:json:0:tool-result',
      role: 'tool',
      text: JSON.stringify(raw.params.item),
      source: 'codex-app-server',
      providerEventType: 'function_call_output',
      provenance: { rawEvents: [raw] },
      createdAt: '2026-07-03T06:28:03.751Z'
    }
  ]);

  expect(
    entries.map((entry) =>
      entry.kind === 'public'
        ? {
            kind: entry.card.kind,
            input: cardEventPayload(entry.card)?.tool?.input,
            output: cardEventPayload(entry.card)?.tool?.output,
            status: cardEventPayload(entry.card)?.tool?.status,
            timestamp: entry.timestamp
          }
        : { kind: entry.kind }
    )
  ).toEqual([
    {
      kind: 'tool',
      input: 'git status --short',
      output: '{"messages":[{"text":"ok"}]}',
      status: 'completed',
      timestamp: undefined
    }
  ]);
});

test('observation card projection maps Codex and Claude command tools to the shared public card', () => {
  const codexEntries = renderTimeline([
    {
      id: 'codex-command',
      role: 'tool',
      text: '{"type":"commandExecution","command":"bun test","aggregatedOutput":"pass"}',
      source: 'codex-app-server',
      providerEventType: 'function_call_output',
      provenance: {
        rawEvents: [
          {
            method: 'item/completed',
            params: {
              item: {
                type: 'commandExecution',
                command: 'bun test',
                status: 'completed',
                aggregatedOutput: 'pass'
              }
            }
          }
        ]
      }
    }
  ]);
  const claudeEntries = renderTimeline([
    {
      id: 'claude-call',
      role: 'tool',
      text: 'Tool call Bash',
      source: 'claude-code-sdk',
      providerEventType: 'tool_use',
      provenance: {
        rawEvents: [
          {
            message: {
              content: [{ type: 'tool_use', id: 'toolu_bash_1', name: 'Bash', input: { command: 'git status' } }]
            }
          }
        ]
      }
    },
    {
      id: 'claude-result',
      role: 'tool',
      text: 'On branch main',
      source: 'claude-code-sdk',
      providerEventType: 'tool_result',
      provenance: {
        rawEvents: [{ type: 'tool_result', tool_use_id: 'toolu_bash_1', output: 'On branch main' }]
      }
    }
  ]);

  expect(codexEntries.map((entry) => (entry.kind === 'public' ? entry.card.kind : entry.kind))).toEqual(['tool']);
  expect(claudeEntries.map((entry) => (entry.kind === 'public' ? entry.card.kind : entry.kind))).toEqual(['tool']);
});

test('Claude Code observation pairs nested SDK tool result with its call', () => {
  const command = 'git status';
  const result = 'On branch main';
  const callRecord = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command } }]
    }
  };
  const resultRecord = {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: result }]
    }
  };
  const output = [JSON.stringify(callRecord), JSON.stringify(resultRecord)].join('\n');

  const items = meshAgentNeutralStreamItems({ id: 'mesh_claude000000', provider: 'claude-code', output });
  expect(
    items.map((item) => ({
      kind: item.kind,
      name: item.kind === 'tool-call' || item.kind === 'tool-result' ? item.tool?.name : undefined
    }))
  ).toEqual([
    { kind: 'tool-call', name: 'Bash' },
    { kind: 'tool-result', name: 'tool' }
  ]);

  const entries = observationTimelineEntries(cardsFromNeutral(items, 'claude-code'), 'claude-code');
  expect(
    entries.map((entry) =>
      entry.kind === 'public' && entry.card.kind === 'tool'
        ? {
            type: entry.card.kind,
            command: cardToolCallPayload(entry.card)?.tool?.input,
            output: cardToolResultPayload(entry.card)?.tool?.output,
            rawEvents: observationContractRawEvents(entry.contractEvents)
          }
        : { type: entry.kind }
    )
  ).toEqual([
    {
      type: 'tool',
      command: { command },
      output: result,
      rawEvents: [callRecord, resultRecord]
    }
  ]);
});

test('Claude Code observation pairs a tool result across intervening events by call id', () => {
  const callId = 'toolu_interleaved';
  const output = "throw new Error('This is file content, not a tool failure');";
  const callRecord = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: callId, name: 'Bash', input: { command: 'cat example.ts' } }]
    }
  };
  const progressRecord = { type: 'system', subtype: 'task_progress' };
  const resultRecord = {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: callId, content: output }]
    }
  };
  const items = meshAgentNeutralStreamItems({
    id: 'mesh_claude000000',
    provider: 'claude-code',
    output: [callRecord, progressRecord, resultRecord].map((record) => JSON.stringify(record)).join('\n')
  });

  expect(
    items.map((item) => ({
      kind: item.kind,
      callId: item.tool?.callId,
      status: item.tool?.status
    }))
  ).toEqual([
    { kind: 'tool-call', callId, status: undefined },
    { kind: 'system', callId: undefined, status: undefined },
    { kind: 'tool-result', callId, status: 'completed' }
  ]);
  expect(
    observationTimelineEntries(cardsFromNeutral(items, 'claude-code'), 'claude-code').map((entry) =>
      entry.kind === 'public' && entry.card.kind === 'tool'
        ? {
            id: entry.id,
            type: entry.card.kind,
            command: cardToolCallPayload(entry.card)?.tool?.input,
            output: cardToolResultPayload(entry.card)?.tool?.output,
            status: cardToolResultPayload(entry.card)?.tool?.status,
            rawEvents: observationContractRawEvents(entry.contractEvents)
          }
        : entry.kind === 'public' && entry.card.kind === 'system'
          ? { id: entry.id, type: cardEventPayload(entry.card)?.kind, text: cardEventPayload(entry.card)?.text }
          : { id: entry.id, type: entry.kind }
    )
  ).toEqual([
    {
      id: 'mesh_claude000000:json:0:tool:0',
      type: 'tool',
      command: { command: 'cat example.ts' },
      output,
      status: 'completed',
      rawEvents: [callRecord, resultRecord]
    }
  ]);
});

test('Claude Code marks a tool result failed only when the provider sets is_error', () => {
  const callId = 'toolu_failed';
  const items = meshAgentNeutralStreamItems({
    id: 'mesh_claude000000',
    provider: 'claude-code',
    output: [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: callId, name: 'Bash', input: { command: 'false' } }]
        }
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: callId, is_error: true, content: 'provider rejected execution' }
          ]
        }
      }
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')
  });

  expect(
    observationTimelineEntries(cardsFromNeutral(items, 'claude-code'), 'claude-code').map((entry) =>
      entry.kind === 'public' && entry.card.kind === 'tool'
        ? {
            type: entry.card.kind,
            output: cardToolResultPayload(entry.card)?.tool?.output,
            status: cardToolResultPayload(entry.card)?.tool?.status
          }
        : { type: entry.kind }
    )
  ).toEqual([{ type: 'tool', output: 'provider rejected execution', status: 'failed' }]);
});

test('an unpaired tool call does not render its call summary as output', () => {
  const entries = observationTimelineEntries(
    cardsFromEvents('claude-code', {
      id: 'call-only',
      kind: 'tool-call',
      streaming: false,
      text: 'Tool call Read {"file_path":"/tmp/example.ts"}',
      tool: { name: 'Read', callId: 'toolu_call_only', input: { file_path: '/tmp/example.ts' } },
      provenance: { contractEvents: [{ type: 'tool_use' }] }
    }),
    'claude-code'
  );

  expect(
    entries.map((entry) =>
      entry.kind === 'public' && entry.card.kind === 'tool'
        ? {
            type: entry.card.kind,
            output: cardToolResultPayload(entry.card)?.tool?.output,
            status: cardToolResultPayload(entry.card)?.tool?.status
          }
        : { type: entry.kind }
    )
  ).toEqual([{ type: 'tool', output: undefined, status: undefined }]);
});

test('observation card projection maps generic tool pairs to the shared command card', () => {
  const entries = renderTimeline([
    {
      id: 'call',
      role: 'tool',
      text: 'Tool call Search {"query":"monad"}',
      source: 'unknown',
      providerEventType: 'tool_use',
      provenance: { rawEvents: [{ name: 'Search', call_id: 'call_search_1' }] }
    },
    {
      id: 'result',
      role: 'tool',
      text: 'No results',
      source: 'unknown',
      providerEventType: 'tool_result',
      provenance: { rawEvents: [{ output: 'No results', call_id: 'call_search_1' }] }
    }
  ]);

  expect(entries.map((entry) => (entry.kind === 'public' ? entry.card.kind : entry.kind))).toEqual(['tool']);
});

test('observation timeline rows keep consecutive tool cards grouped for virtual rendering', () => {
  const entries = renderTimeline([
    {
      id: 'message-before',
      role: 'agent',
      text: 'Before tools',
      source: 'codex-app-server',
      provenance: { rawEvents: [{ type: 'assistant', text: 'Before tools' }] }
    },
    {
      id: 'call-one',
      role: 'tool',
      text: 'Tool call Search {"query":"monad"}',
      source: 'unknown',
      providerEventType: 'tool_use',
      provenance: { rawEvents: [{ name: 'Search', call_id: 'call_one' }] }
    },
    {
      id: 'result-one',
      role: 'tool',
      text: 'No results',
      source: 'unknown',
      providerEventType: 'tool_result',
      provenance: { rawEvents: [{ output: 'No results', call_id: 'call_one' }] }
    },
    {
      id: 'call-two',
      role: 'tool',
      text: 'Tool call Bash',
      source: 'unknown',
      providerEventType: 'tool_use',
      provenance: { rawEvents: [{ name: 'Bash', call_id: 'call_two' }] }
    },
    {
      id: 'result-two',
      role: 'tool',
      text: 'done',
      source: 'unknown',
      providerEventType: 'tool_result',
      provenance: { rawEvents: [{ output: 'done', call_id: 'call_two' }] }
    },
    {
      id: 'message-after',
      role: 'agent',
      text: 'After tools',
      source: 'codex-app-server',
      provenance: { rawEvents: [{ type: 'assistant', text: 'After tools' }] }
    }
  ]);

  expect(observationTimelineRows(entries).map((row) => row.entries.length)).toEqual([1, 1, 1, 1]);
});

test('prepending adjacent tools preserves stable card row ids', () => {
  const toolEntry = (id: string): ObservationTimelineEntry => ({
    id,
    kind: 'public',
    card: {
      id,
      kind: 'tool',
      streaming: false,
      payload: { provider: 'claude-code' },
      provenance: { contractEvents: [{ id }] }
    },
    contractEvents: [{ id }]
  });
  const current = observationTimelineRows([toolEntry('call-newer'), toolEntry('call-latest')]);
  const prepended = observationTimelineRows([
    toolEntry('call-oldest'),
    toolEntry('call-newer'),
    toolEntry('call-latest')
  ]);

  expect({ current: current[0]?.id, prepended: prepended[0]?.id }).toEqual({
    current: 'call-newer',
    prepended: 'call-oldest'
  });
});

test('a single tool uses its stable card id before older adjacent tools arrive', () => {
  const toolEntry = (id: string): ObservationTimelineEntry => ({
    id,
    kind: 'public',
    card: {
      id,
      kind: 'tool',
      streaming: false,
      payload: { provider: 'claude-code' },
      provenance: { contractEvents: [{ id }] }
    },
    contractEvents: [{ id }]
  });
  const single = observationTimelineRows([toolEntry('call-latest')]);
  const prepended = observationTimelineRows([toolEntry('call-older'), toolEntry('call-latest')]);

  expect({ prepended: prepended[0]?.id, single: single[0]?.id }).toEqual({
    prepended: 'call-older',
    single: 'call-latest'
  });
});

test('full observation frames retain unchanged item references and replace only the streaming tail', () => {
  const item = (id: string, text: string, streaming = false): AgentObservationCard => messageCard(id, text, streaming);
  const previous = [item('events', 'settled'), item('tail', 'Hello', true)];
  const repeated = reconcileObservationItems(previous, [item('events', 'settled'), item('tail', 'Hello', true)]);
  const updated = reconcileObservationItems(repeated, [item('events', 'settled'), item('tail', 'Hello world', true)]);

  expect({
    repeatedArray: repeated === previous,
    repeatedEvents: repeated[0] === previous[0],
    repeatedTail: repeated[1] === previous[1],
    updatedEvents: updated[0] === previous[0],
    updatedTail: updated[1] === previous[1],
    updatedText: updated[1] ? cardEventPayload(updated[1])?.text : undefined
  }).toEqual({
    repeatedArray: true,
    repeatedEvents: true,
    repeatedTail: true,
    updatedEvents: true,
    updatedTail: false,
    updatedText: 'Hello world'
  });
});

test('observation reconciliation refreshes an earlier tool card when its result arrives after a system event', () => {
  const provenance: AgentObservationEvent['provenance'] = { contractEvents: [{ source: 'claude-code' }] };
  const call: AgentObservationEvent = {
    id: 'call',
    kind: 'tool-call',
    streaming: false,
    tool: { name: 'Bash', callId: 'toolu_1', input: 'pwd' },
    provenance
  };
  const hook: AgentObservationEvent = {
    id: 'hook',
    kind: 'system',
    streaming: false,
    text: 'hook_response',
    provenance
  };
  const result: AgentObservationEvent = {
    id: 'result',
    kind: 'tool-result',
    streaming: false,
    tool: { name: 'Bash', callId: 'toolu_1', output: '/workspace', status: 'completed' },
    provenance
  };
  const previous = agentObservationCards([call, hook], 'claude-code');
  const next = agentObservationCards([call, hook, result], 'claude-code');
  const reconciled = reconcileObservationItems(previous, next);
  const tool = reconciled[0]?.payload.result as AgentObservationEvent | undefined;

  expect({
    toolCardChanged: reconciled[0] !== previous[0],
    hookCardRetained: reconciled[1] === previous[1],
    result: tool
      ? {
          id: tool.id,
          kind: tool.kind,
          output: tool.tool?.output,
          status: tool.tool?.status
        }
      : null
  }).toEqual({
    toolCardChanged: true,
    hookCardRetained: true,
    result: {
      id: 'result',
      kind: 'tool-result',
      output: '/workspace',
      status: 'completed'
    }
  });
});

test('timeline reconciliation preserves historical rows while a streaming tail grows', () => {
  const entry = (id: string, text: string): ObservationTimelineEntry => ({
    id,
    kind: 'public',
    card: messageCard(id, text, id === 'tail'),
    contractEvents: [{ id, text }]
  });
  const events = entry('events', 'settled');
  const previous = observationTimelineRows([events, entry('tail', 'Hello')]);
  const next = observationTimelineRows([events, entry('tail', 'Hello world')]);
  const reconciled = reconcileObservationTimelineRows(previous, next);

  expect({
    eventsReused: reconciled[0] === previous[0],
    tailReused: reconciled[1] === previous[1],
    tailText:
      reconciled[1]?.entries[0]?.kind === 'public' && reconciled[1].entries[0].card.kind === 'message'
        ? cardEventPayload(reconciled[1].entries[0].card)?.text
        : undefined
  }).toEqual({ eventsReused: true, tailReused: false, tailText: 'Hello world' });
});

test('timeline reconciliation appends a settled row without replacing existing message rows', () => {
  const entry = (id: string): ObservationTimelineEntry => {
    const item: AgentObservationEvent = {
      id,
      kind: 'assistant-message',
      streaming: false,
      text: id,
      provenance: { contractEvents: [{ id }] }
    };
    return {
      id,
      kind: 'public',
      card: cardFromEvent(item),
      contractEvents: item.provenance.contractEvents
    };
  };
  const events = entry('events');
  const tail = entry('tail');
  const previous = observationTimelineRows([events, tail]);
  const next = observationTimelineRows([events, tail, entry('appended')]);
  const reconciled = reconcileObservationTimelineRows(previous, next);

  expect({
    eventsReused: reconciled[0] === previous[0],
    tailReused: reconciled[1] === previous[1],
    appendedId: reconciled[2]?.id
  }).toEqual({ eventsReused: true, tailReused: true, appendedId: 'appended' });
});

test('observation card projection normalizes JSON-like generic tool output', () => {
  const entries = renderTimeline([
    {
      id: 'call',
      role: 'tool',
      text: 'Tool call Search {"query":"monad"}',
      source: 'codex-app-server',
      providerEventType: 'function_call',
      provenance: { rawEvents: [{ name: 'Search', call_id: 'call_search_json' }] }
    },
    {
      id: 'result',
      role: 'tool',
      text: '\n"{\\"ok\\":true}"\n',
      source: 'codex-app-server',
      providerEventType: 'function_call_output',
      provenance: { rawEvents: [{ output: '\n"{\\"ok\\":true}"\n', call_id: 'call_search_json' }] }
    }
  ]);

  expect(
    entries.map((entry) => (entry.kind === 'public' ? cardToolResultPayload(entry.card)?.tool?.output : undefined))
  ).toEqual(['\n"{\\"ok\\":true}"\n']);
});

test('observation card projection maps standalone Codex function call output to the shared command card', () => {
  const entries = renderTimeline([
    {
      id: 'codex-output',
      role: 'tool',
      text: JSON.stringify({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              items: [{ message: { role: 'assistant', text: 'ok' } }],
              seq: 102
            })
          }
        ]
      }),
      source: 'codex-app-server',
      providerEventType: 'function_call_output',
      provenance: {
        rawEvents: [
          {
            output: JSON.stringify({
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    items: [{ message: { role: 'assistant', text: 'ok' } }],
                    seq: 102
                  })
                }
              ]
            })
          }
        ]
      }
    }
  ]);

  expect(
    entries.map((entry) => (entry.kind === 'public' ? cardEventPayload(entry.card)?.tool?.output : undefined))
  ).toEqual([
    JSON.stringify({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            items: [{ message: { role: 'assistant', text: 'ok' } }],
            seq: 102
          })
        }
      ]
    })
  ]);
});

test('Claude Code Read tool result renders as a file read card', () => {
  const items = [
    {
      id: 'claude-read-call',
      role: 'tool',
      text: 'Tool call Read',
      source: 'claude-code-sdk',
      providerEventType: 'tool_use',
      provenance: {
        rawEvents: [
          {
            message: {
              content: [
                { type: 'tool_use', id: 'toolu_read_1', name: 'Read', input: { file_path: '/tmp/example.tsx' } }
              ]
            }
          }
        ]
      }
    },
    {
      id: 'claude-read-result',
      role: 'tool',
      text: 'export function Example() { return <div />; }',
      source: 'claude-code-sdk',
      providerEventType: 'tool_result',
      provenance: {
        rawEvents: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_read_1',
            output: 'export function Example() { return <div />; }'
          }
        ]
      }
    }
  ] as const;
  const entries = renderTimeline(items as never);

  expect(
    entries.map((entry) =>
      entry.kind === 'public'
        ? {
            input: cardToolCallPayload(entry.card)?.tool?.input,
            output: cardToolResultPayload(entry.card)?.tool?.output
          }
        : undefined
    )
  ).toEqual([
    {
      input: { file_path: '/tmp/example.tsx' },
      output: 'export function Example() { return <div />; }'
    }
  ]);
});

test('Claude Code observation keeps result-delimited SDK queries in timeline order', () => {
  const output = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude_session' }),
    JSON.stringify({
      type: 'assistant',
      session_id: 'claude_session',
      message: { role: 'assistant', content: [{ type: 'text', text: 'First response' }] }
    }),
    JSON.stringify({ type: 'result', subtype: 'success', session_id: 'claude_session', result: 'First response' }),
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude_session' }),
    JSON.stringify({
      type: 'assistant',
      session_id: 'claude_session',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Second response' }] }
    }),
    JSON.stringify({ type: 'result', subtype: 'success', session_id: 'claude_session', result: 'Second response' })
  ].join('\n');

  const items = meshAgentStreamItems({ id: 'mesh_claude000000', provider: 'claude-code', output });

  expect(items.map((item) => item.text)).toEqual([
    'init',
    'First response',
    'First response',
    'init',
    'Second response',
    'Second response'
  ]);
  expect(items.map((item) => item.source)).toEqual([
    'claude-code-sdk',
    'claude-code-sdk',
    'claude-code-sdk',
    'claude-code-sdk',
    'claude-code-sdk',
    'claude-code-sdk'
  ]);
});
