import type { AgentObservationEvent, ExternalAgentObservationEvent } from '@monad/protocol';
import type { ExternalAgentStreamView } from '../../src/workspace-experiences/experience/types.ts';

import { expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { builtinAgentAdapters } from '../../src/agent-adapters/index.ts';
import { toAgentObservationEvent } from '../../src/agent-adapters/neutral-observation.ts';
import { rawJsonText } from '../../src/workspace-experiences/chat-room/components/observation/card-shell.tsx';
import { ExternalAgentObservationPanel } from '../../src/workspace-experiences/chat-room/components/observation/panel.tsx';
import {
  observationTimelineEntries,
  observationTimelineRows
} from '../../src/workspace-experiences/chat-room/components/observation/timeline.tsx';
import {
  observationProjectionFromAccess,
  shouldProjectObservationAccess,
  streamWithObservationProjection,
  usageMeterFromObservationAccess
} from '../../src/workspace-experiences/chat-room/utils/agent-rail-model.ts';
import {
  configureExternalAgentObservationAdapterResolver,
  externalAgentNeutralStreamItems,
  externalAgentStreamItems,
  externalAgentUsageLimitMeter,
  externalAgentUsageLimitMeterFromResponse
} from '../../src/workspace-experiences/experience/external-agent-observation/external-agent-observation.ts';

configureExternalAgentObservationAdapterResolver((provider) =>
  builtinAgentAdapters.find((adapter) => adapter.provider === provider)
);

// The timeline renders neutral AgentObservationEvent[]; these tests build legacy events (via
// externalAgentStreamItems), so convert them the same way the daemon's ui plane does before rendering.
const renderTimeline = (items: ExternalAgentObservationEvent[], provider = 'codex') =>
  observationTimelineEntries(
    items
      .map((event) => toAgentObservationEvent(event))
      .filter((event): event is AgentObservationEvent => event !== null),
    provider
  );

test('observation access is adapted to projection events without carrying raw output forward', () => {
  const raw = JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'Projected update' } });
  const stream = {
    id: 'exa_codex0000000',
    agentName: 'codex',
    provider: 'codex',
    tag: 'Codex',
    status: 'running',
    output: '',
    items: []
  } satisfies ExternalAgentStreamView;

  const projection = observationProjectionFromAccess(stream, {
    state: 'live',
    externalAgentSessionId: 'exa_codex0000000',
    provider: 'codex',
    output: raw,
    // The daemon normalizes `output` into `events` with the same adapter before sending the access
    // response — the client never re-derives this from raw output (see observeFromStore/
    // observeWithProviderHistory in apps/monad/src/services/external-agent/host.ts).
    events: externalAgentStreamItems({ id: 'exa_codex0000000', provider: 'codex', output: raw }),
    observedAt: '2026-06-28T00:00:00.000Z'
  });
  const projectedStream = streamWithObservationProjection(stream, projection);

  expect(projection?.state).toBe('live');
  expect(projectedStream?.items.map((item) => item.text)).toEqual(['Projected update']);
  expect(projectedStream?.output).toBe('Projected update');
  expect(projectedStream?.output).not.toBe(raw);
});

test('live SSE frame without events derives them from the folded output', () => {
  // The SSE hub sends full `output` (or an `append` folded to full `output`) with no normalized
  // `events` on steady-state pushes; the projection must re-derive events from `output` so the panel
  // does not blank between full snapshots.
  const stream = {
    id: 'exa_codex0000000',
    agentName: 'codex',
    provider: 'codex',
    tag: 'Codex',
    status: 'running',
    output: '',
    items: []
  } satisfies ExternalAgentStreamView;
  const output = JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'Streaming reply' } });

  const projection = observationProjectionFromAccess(stream, {
    state: 'live',
    externalAgentSessionId: 'exa_codex0000000',
    provider: 'codex',
    output,
    observedAt: '2026-07-07T00:00:00.000Z'
  });

  expect(streamWithObservationProjection(stream, projection)?.items.map((item) => item.text)).toEqual([
    'Streaming reply'
  ]);
});

test('delivery observation access keeps the delivery pointer on the projection', () => {
  const stream = {
    id: 'exa_codex0000000',
    agentName: 'codex',
    provider: 'codex',
    tag: 'Codex',
    status: 'running',
    output: '',
    items: []
  } satisfies ExternalAgentStreamView;

  expect(
    observationProjectionFromAccess(
      stream,
      {
        state: 'live',
        externalAgentSessionId: 'exa_codex0000000',
        provider: 'codex',
        deliveryId: 'deliv_01KWEBDErrBa',
        turn: { providerSessionRef: 'provider-session-1', providerTurnId: 'turn-1' },
        output: '',
        observedAt: '2026-06-28T00:00:00.000Z'
      },
      undefined
    )
  ).toMatchObject({
    externalAgentSessionId: 'exa_codex0000000',
    deliveryId: 'deliv_01KWEBDErrBa',
    turn: { providerTurnId: 'turn-1' }
  });
});

test('history observation access with normalized events projects immediately', () => {
  expect(
    shouldProjectObservationAccess({
      access: {
        state: 'history',
        externalAgentSessionId: 'exa_codex0000000',
        provider: 'codex',
        output: '',
        events: [{ id: 'event_1', role: 'agent', source: 'codex-app-server', text: 'Projected history' }],
        observedAt: '2026-07-06T00:00:00.000Z'
      },
      historyRequested: false
    })
  ).toBe(true);

  expect(
    shouldProjectObservationAccess({
      access: {
        state: 'history',
        externalAgentSessionId: 'exa_codex0000000',
        provider: 'codex',
        output: '',
        events: [],
        observedAt: '2026-07-06T00:00:00.000Z'
      },
      historyRequested: false
    })
  ).toBe(false);
});

test('host external agent usage records project to a usage limits meter', () => {
  const meter = externalAgentUsageLimitMeterFromResponse({
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

test('observation rail usage fallback reads raw access output before projected display text', () => {
  const raw = JSON.stringify({
    method: 'account/rateLimits/updated',
    params: {
      rateLimits: {
        primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1_782_935_600_000 }
      }
    }
  });
  const stream = {
    id: 'exa_codex0000000',
    agentName: 'codex',
    provider: 'codex',
    tag: 'Codex',
    status: 'running',
    output: 'Readable agent output only',
    items: []
  } satisfies ExternalAgentStreamView;

  const meter = usageMeterFromObservationAccess({
    access: {
      state: 'live',
      externalAgentSessionId: 'exa_codex0000000',
      provider: 'codex',
      output: raw,
      // Server-normalized, same as `events` — the daemon computes this from `raw`, the client never
      // re-derives it from `stream.output` when an access response is present.
      usageMeter: externalAgentUsageLimitMeter({ provider: 'codex', output: raw }),
      observedAt: '2026-06-28T00:00:00.000Z'
    },
    provider: 'codex',
    stream
  });

  expect(meter?.rows).toMatchObject([{ id: 'primary', percent: 70 }]);
});

test('Claude Code observation keeps a result marker without repeating assistant text', () => {
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
    externalAgentStreamItems({ id: 'exa_claude000000', provider: 'claude-code', output }).map((item) => item.text)
  ).toEqual(['Joined the project and posted status.', 'Result: success']);
});

test('Claude Code observation maps server errors to readable system events', () => {
  const output = JSON.stringify({
    type: 'result',
    subtype: 'server_error',
    is_error: true,
    result: 'API Error: overloaded_error. Claude Code is currently overloaded.',
    session_id: 'claude-session'
  });

  expect(externalAgentStreamItems({ id: 'exa_claude000000', provider: 'claude-code', output })).toEqual([
    {
      id: 'exa_claude000000:result',
      role: 'system',
      text: 'API Error: overloaded_error. Claude Code is currently overloaded.',
      source: 'claude-code-sdk',
      providerEventType: 'server_error',
      raw: {
        type: 'result',
        subtype: 'server_error',
        is_error: true,
        result: 'API Error: overloaded_error. Claude Code is currently overloaded.',
        session_id: 'claude-session'
      }
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

  const items = externalAgentStreamItems({ id: 'exa_qwen00000000', provider: 'qwen', output });

  expect(
    items.map((item) => ({ role: item.role, source: item.source, type: item.providerEventType, text: item.text }))
  ).toEqual([
    { role: 'system', source: 'qwen-code-sdk', type: 'system', text: 'session_start' },
    { role: 'agent', source: 'qwen-code-sdk', type: 'assistant', text: 'I will inspect the project first.' },
    { role: 'agent', source: 'qwen-code-sdk', type: 'result', text: 'Result: success' }
  ]);
});

test('Codex app-server observation renders reasoning and diff streams', () => {
  const output = [
    JSON.stringify({ method: 'item/reasoning/summaryTextDelta', params: { itemId: 'r1', delta: 'Considering ' } }),
    JSON.stringify({ method: 'item/reasoning/summaryTextDelta', params: { itemId: 'r1', delta: 'the plan.' } }),
    JSON.stringify({ method: 'turn/diff/updated', params: { threadId: 't', turnId: 'u', diff: '--- a\n+++ b\n' } })
  ].join('\n');

  const items = externalAgentStreamItems({ id: 'exa_codex0000000', provider: 'codex', output });
  expect(items.map((item) => ({ role: item.role, type: item.providerEventType, text: item.text }))).toEqual([
    { role: 'agent', type: 'item/reasoning/summaryTextDelta', text: 'Considering the plan.' },
    { role: 'tool', type: 'turn/diff/updated', text: '--- a\n+++ b\n' }
  ]);
});

test('external agent observation projects thinking records from all adapters', () => {
  const cases = [
    {
      provider: 'claude-code',
      output: JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'thinking', thinking: '' }] }
      }),
      source: 'claude-code-sdk',
      type: 'thinking',
      text: 'Thinking…'
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
    const [item] = externalAgentStreamItems({
      id: `exa_${expected.provider}`,
      provider: expected.provider,
      output: expected.output
    });
    expect(item).toMatchObject({
      role: 'agent',
      source: expected.source,
      providerEventType: expected.type,
      text: expected.text
    });
    expect(renderTimeline(item ? [item] : [])[0]?.card.type).toBe('thinking');
  }
});

test('external agent observation merges streaming thinking deltas', () => {
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
    externalAgentStreamItems({ id: 'exa_claude000000', provider: 'claude-code', output: claudeOutput })
  ).toMatchObject([
    {
      role: 'agent',
      source: 'claude-code-sdk',
      providerEventType: 'thinking_delta',
      text: 'Analyzing context.'
    }
  ]);
  expect(externalAgentStreamItems({ id: 'exa_qwen00000000', provider: 'qwen', output: qwenOutput })).toMatchObject([
    {
      role: 'agent',
      source: 'qwen-code-sdk',
      providerEventType: 'thinking_delta',
      text: 'Checking state.'
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

  expect(externalAgentStreamItems({ id: 'exa_qwen00000000', provider: 'qwen', output })).toMatchObject([
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

  expect(externalAgentStreamItems({ id: 'exa_unknown00000', provider: 'claude-code', output: raw })).toEqual([
    {
      id: 'exa_unknown00000:json:0:raw',
      role: 'system',
      text: raw,
      source: 'unknown',
      providerEventType: 'raw_json',
      raw: { type: 'unexpected_event', payload: { value: 42 } }
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

  expect(externalAgentStreamItems({ id: 'exa_codex0000000', provider: 'codex', output })).toEqual([
    {
      id: 'exa_codex0000000:0',
      role: 'agent',
      text: output,
      source: 'plain-text'
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

  expect(
    externalAgentStreamItems({ id: 'exa_codex0000000', provider: 'codex', output }).map((item) => item.text)
  ).toEqual(['Hello, world']);
});

test('Codex app-server observation collects merged chunk raw JSONL lines into a flat array', () => {
  const records = [
    { method: 'item/agentMessage/delta', params: { delta: 'a' } },
    { method: 'item/agentMessage/delta', params: { delta: 'b' } },
    { method: 'item/agentMessage/delta', params: { delta: 'c' } }
  ];
  const rawLines = records.map((record) => JSON.stringify(record));
  const output = rawLines.join('\n');

  const items = externalAgentStreamItems({ id: 'exa_codex0000000', provider: 'codex', output });

  expect(items).toHaveLength(1);
  expect(items[0]?.text).toBe('abc');
  expect(items[0]?.raw).toEqual(rawLines);
  expect(rawJsonText(items[0]?.raw)).toBe(output);
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

  const items = externalAgentStreamItems({ id: 'exa_codex0000000', provider: 'codex', output });

  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    role: 'agent',
    source: 'codex-app-server',
    providerEventType: 'item/agentMessage',
    text: "I'll fetch zeke's pending message now."
  });
  expect(items[0]?.raw).toEqual(rawLines);
  expect(rawJsonText(items[0]?.raw)).toBe(output);
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

  const items = externalAgentStreamItems({ id: 'exa_codex0000000', provider: 'codex', output });

  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    role: 'user',
    source: 'codex-app-server',
    providerEventType: 'item/userMessage',
    text: 'You have just joined this Workplace Project.\nUse project_post for the public status message.'
  });
  expect(items[0]?.raw).toEqual(rawLines);
  expect(rawJsonText(items[0]?.raw)).toBe(output);
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

  const items = externalAgentStreamItems({ id: 'exa_codex0000000', provider: 'codex', output });

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
  const entries = renderTimeline(externalAgentStreamItems({ id: 'exa_codex0000000', provider: 'codex', output }));

  expect(entries).toMatchObject([
    {
      card: {
        item: {
          kind: 'user-message',
          text: 'You have just joined this Workplace Project.\nUse project_post for the public status message.'
        },
        role: 'user',
        type: 'message'
      },
      kind: 'public'
    }
  ]);
});

test('Codex app-server observation keeps a lone chunk raw record unwrapped', () => {
  const record = { method: 'item/agentMessage/delta', params: { delta: 'solo' } };

  const items = externalAgentStreamItems({ id: 'exa_codex0000000', provider: 'codex', output: JSON.stringify(record) });

  expect(items).toHaveLength(1);
  expect(items[0]?.raw).toEqual(record);
});

test('Codex app-server observation concatenates deltas verbatim without injecting spaces', () => {
  const output = [
    JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'impl' } }),
    JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'ementation' } })
  ].join('\n');

  expect(
    externalAgentStreamItems({ id: 'exa_codex0000000', provider: 'codex', output }).map((item) => item.text)
  ).toEqual(['implementation']);
});

test('Codex app-server observation does not insert spaces between CJK deltas', () => {
  const output = [
    JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: '我来' } }),
    JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: '先做大文件' } }),
    JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: '盘点' } })
  ].join('\n');

  expect(
    externalAgentStreamItems({ id: 'exa_codex0000000', provider: 'codex', output }).map((item) => item.text)
  ).toEqual(['我来先做大文件盘点']);
});

test('Codex app-server observation keeps codex-sent whitespace across clause punctuation', () => {
  const output = [
    JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'already gone;' } }),
    JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: ' I am checking now.' } }),
    JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: ' Two branches remain.' } })
  ].join('\n');

  expect(
    externalAgentStreamItems({ id: 'exa_codex0000000', provider: 'codex', output }).map((item) => item.text)
  ).toEqual(['already gone; I am checking now. Two branches remain.']);
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

  const items = externalAgentStreamItems({ id: 'exa_codex0000000', provider: 'codex', output });

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

  const items = externalAgentStreamItems({ id: 'exa_codex0000000', provider: 'codex', output });

  expect(items.map((item) => ({ role: item.role, type: item.providerEventType, text: item.text }))).toEqual([
    {
      role: 'tool',
      type: 'function_call',
      text: 'Tool call Bash {"command":"git status","description":"Check status"}'
    },
    { role: 'tool', type: 'function_call_output', text: 'On branch main' }
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

  const items = externalAgentStreamItems({ id: 'exa_codex0000000', provider: 'codex', output });

  expect(items.map((item) => ({ role: item.role, type: item.providerEventType, text: item.text }))).toEqual([
    { role: 'tool', type: 'function_call', text: 'Tool call commandExecution bun test' },
    { role: 'tool', type: 'item/commandExecution/outputDelta', text: 'running tests' },
    { role: 'tool', type: 'function_call_output', text: 'ok' }
  ]);
});

test('Codex observation does not project a capped partial JSON record as one giant message', () => {
  const output = `truncated provider payload ${'x'.repeat(70_000)} \\"method\\":\\"item/completed\\"}`;

  expect(externalAgentStreamItems({ id: 'exa_codex0000000', provider: 'codex', output })).toEqual([]);
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
  const first = externalAgentStreamItems({
    id: 'exa_codex0000000',
    provider: 'codex',
    output: [JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread_1' } }), completed].join(
      '\n'
    )
  });
  const shifted = externalAgentStreamItems({ id: 'exa_codex0000000', provider: 'codex', output: completed });

  expect(first.filter((item) => item.role === 'tool').map((item) => item.id)).toEqual(
    shifted.filter((item) => item.role === 'tool').map((item) => item.id)
  );
});

test('Codex app-server observation projects completed MCP tool calls with arguments and result', () => {
  const output = JSON.stringify({
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
          query: 'apps/web external agent settings',
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
  });

  const items = externalAgentStreamItems({ id: 'exa_codex0000000', provider: 'codex', output });

  expect(items.map((item) => ({ role: item.role, type: item.providerEventType, text: item.text }))).toEqual([
    {
      role: 'tool',
      type: 'function_call',
      text: 'Tool call codegraph_explore {"projectPath":"/private/tmp/monad-a2a-agent","query":"apps/web external agent settings","maxFiles":8}'
    },
    {
      role: 'tool',
      type: 'function_call_output',
      text: 'Found 209 symbols across 91 files.'
    }
  ]);

  expect(renderTimeline(items).map((entry) => entry.card?.type)).toEqual(['command-tool']);
});

test('Codex app-server observation projects turns page responses', () => {
  const output = JSON.stringify({
    id: 17,
    result: {
      data: [
        {
          id: 'turn_1',
          items: [
            { type: 'userMessage', id: 'item_1', text: 'Inspect external agent settings' },
            {
              type: 'mcpToolCall',
              id: 'call_1',
              server: 'codegraph',
              tool: 'codegraph_explore',
              status: 'completed',
              arguments: { query: 'external agent settings', maxFiles: 4 },
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

  const items = externalAgentStreamItems({ id: 'exa_codex0000000', provider: 'codex', output });

  expect(items.map((item) => ({ role: item.role, type: item.providerEventType, text: item.text }))).toEqual([
    { role: 'user', type: 'item/userMessage', text: 'Inspect external agent settings' },
    {
      role: 'tool',
      type: 'function_call',
      text: 'Tool call codegraph_explore {"query":"external agent settings","maxFiles":4}'
    },
    {
      role: 'tool',
      type: 'function_call_output',
      text: 'Found settings code.'
    },
    { role: 'agent', type: 'item/agentMessage', text: 'The settings form owns this surface.' }
  ]);
  expect(renderTimeline(items).map((entry) => entry.card?.type)).toEqual(['message', 'command-tool', 'message']);
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
          action: {
            type: 'search',
            query: 'react-native-libsodium GitHub crypto_kx',
            queries: ['react-native-libsodium GitHub crypto_kx']
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

  expect(externalAgentStreamItems({ id: 'exa_codex0000000', provider: 'codex', output })).toMatchObject([
    {
      role: 'tool',
      source: 'codex-app-server',
      providerEventType: 'function_call',
      text: 'Tool call webSearch {"type":"search","query":"react-native-libsodium GitHub crypto_kx","queries":["react-native-libsodium GitHub crypto_kx"]}'
    },
    {
      role: 'system',
      source: 'codex-app-server',
      providerEventType: 'contextCompaction',
      text: 'Context compacted'
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

  expect(externalAgentUsageLimitMeter({ provider: 'codex', output })).toMatchObject({
    title: 'Usage remaining',
    rows: [
      { id: 'primary', label: '5-hour limit', percent: 94 },
      { id: 'secondary', label: 'Weekly · all models', percent: 75 }
    ]
  });
  expect(
    externalAgentStreamItems({ id: 'exa_codex0000000', provider: 'codex', output }).map((item) => item.text)
  ).toEqual(['Usage limits updated']);
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

  expect(externalAgentUsageLimitMeter({ provider: 'codex', output })).toMatchObject({
    title: 'Token usage',
    rows: [
      { id: 'last_turn', label: 'Last turn', percent: 26, meterPercent: 26 },
      { id: 'thread_total', label: 'Thread total', percent: 398, meterPercent: 100 }
    ]
  });
  expect(
    externalAgentStreamItems({ id: 'exa_codex0000000', provider: 'codex', output }).map((item) => item.text)
  ).toEqual(['Token usage updated']);
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

  expect(externalAgentUsageLimitMeter({ provider: 'claude-code', output })).toMatchObject({
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

  expect(externalAgentStreamItems({ id: 'exa_claude000000', provider: 'claude-code', output })).toMatchObject([
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

  expect(externalAgentUsageLimitMeter({ provider: 'claude-code', output })).toMatchObject({
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
  expect(externalAgentUsageLimitMeter({ provider: 'codex', output })).toBeNull();
});

test('observation panel shows a token usage meter entry when Codex reports token usage', () => {
  const output = JSON.stringify({
    method: 'thread/tokenUsage/updated',
    params: {
      tokenUsage: {
        total: { totalTokens: 1_029_307 },
        last: { totalTokens: 68_235 },
        modelContextWindow: 258_400
      }
    }
  });
  const html = renderToStaticMarkup(
    React.createElement(ExternalAgentObservationPanel, {
      onStop: () => {},
      stream: {
        id: 'exa_codex0000000',
        agentName: 'codex',
        provider: 'codex',
        tag: 'Codex',
        status: 'running',
        output,
        items: externalAgentNeutralStreamItems({ id: 'exa_codex0000000', provider: 'codex', output })
      },
      // The panel renders whatever meter it's given (server-normalized in production); it no longer
      // re-derives one from `stream.output` itself.
      usageMeter: externalAgentUsageLimitMeter({ provider: 'codex', output })
    })
  );
  expect(html).toContain('aria-label="Show token usage"');
});

test('observation panel shows a usage limits entry when the stream has limit data', () => {
  const output = JSON.stringify({
    method: 'account/rateLimits/updated',
    params: { rateLimits: { primary: { usedPercent: 6, windowDurationMins: 300, resetsAt: 1_782_935_600_000 } } }
  });
  const usageMeter = externalAgentUsageLimitMeter({ provider: 'codex', output });
  const html = renderToStaticMarkup(
    React.createElement(ExternalAgentObservationPanel, {
      onStop: () => {},
      stream: {
        id: 'exa_codex0000000',
        agentName: 'codex',
        provider: 'codex',
        tag: 'Codex',
        status: 'running',
        output,
        items: externalAgentNeutralStreamItems({ id: 'exa_codex0000000', provider: 'codex', output })
      },
      usageMeter
    })
  );
  expect(html).toContain('aria-label="Show usage remaining"');
});

test('observation panel distinguishes unavailable provider history from empty live activity', () => {
  const html = renderToStaticMarkup(
    React.createElement(ExternalAgentObservationPanel, {
      onStop: () => {},
      stream: {
        id: 'exa_codex0000000',
        agentName: 'codex',
        provider: 'codex',
        tag: 'Codex',
        status: 'ok',
        output: '',
        items: []
      }
    })
  );
  expect(html).toContain('Agent currently not running');
  expect(html).not.toContain('No activity yet.');
});

test('observation panel renders show history as the first list placeholder when activity exists', () => {
  const html = renderToStaticMarkup(
    React.createElement(ExternalAgentObservationPanel, {
      onShowHistory: () => {},
      onStop: () => {},
      showHistoryButton: true,
      stream: {
        id: 'exa_codex0000000',
        agentName: 'codex',
        provider: 'codex',
        tag: 'Codex',
        status: 'ok',
        output: 'Agent output',
        items: [{ id: 'evt_100000000000', kind: 'assistant-message', streaming: false, text: 'Agent output' }]
      }
    })
  );

  expect(html.indexOf('data-observation-list-placeholder="history"')).toBeGreaterThan(html.indexOf('role="log"'));
});

test('observation panel summary mode folds turn details and shows only the final output summary', () => {
  const html = renderToStaticMarkup(
    React.createElement(ExternalAgentObservationPanel, {
      defaultRenderMode: 'summary',
      onStop: () => {},
      stream: {
        id: 'exa_codex0000000',
        agentName: 'codex',
        provider: 'codex',
        tag: 'Codex',
        status: 'ok',
        output: '',
        items: [
          { id: 'evt_1', kind: 'turn-start', streaming: false, at: '2026-07-15T00:00:00.000Z' },
          {
            id: 'evt_2',
            kind: 'reasoning',
            streaming: false,
            text: 'private thinking',
            at: '2026-07-15T00:00:12.000Z'
          },
          {
            id: 'evt_3',
            kind: 'assistant-message',
            streaming: false,
            text: 'first draft output',
            at: '2026-07-15T00:00:30.000Z'
          },
          {
            id: 'evt_4',
            kind: 'assistant-message',
            streaming: false,
            text: 'final answer output',
            at: '2026-07-15T00:01:10.000Z'
          },
          {
            id: 'evt_5',
            kind: 'turn-end',
            streaming: false,
            reason: 'completed',
            at: '2026-07-15T00:01:12.000Z'
          }
        ]
      }
    })
  );

  expect(html).toContain('Completed for 1m12s');
  expect(html).toContain('final answer output');
  expect(html).toContain('Show turn details');
  expect(html.indexOf('final answer output')).toBeLessThan(html.indexOf('private thinking'));
});

test('observation panel accepts a controlled render mode command', () => {
  const html = renderToStaticMarkup(
    React.createElement(ExternalAgentObservationPanel, {
      onRenderModeChange: () => {},
      onStop: () => {},
      renderMode: 'summary',
      stream: {
        id: 'exa_codex0000000',
        agentName: 'codex',
        provider: 'codex',
        tag: 'Codex',
        status: 'running',
        output: '',
        items: [
          { id: 'evt_1', kind: 'turn-start', streaming: false, at: '2026-07-15T00:00:00.000Z' },
          {
            id: 'evt_2',
            kind: 'assistant-message',
            streaming: false,
            text: 'live output',
            at: '2026-07-15T00:00:05.000Z'
          }
        ]
      }
    })
  );

  expect(html).toContain('Running for');
  expect(html).toContain('live output');
  expect(html).toContain('aria-pressed="true"');
  expect(html).toContain('Summary observation view');
  expect(html).toContain('data-observation-turn-mode="summary"');
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
  const entries = renderTimeline(externalAgentStreamItems({ id: 'exa_claude000000', provider: 'claude-code', output }));

  expect(entries).toMatchObject([
    {
      card: {
        item: {
          kind: 'user-message',
          text: 'New Workplace Project message is available.'
        },
        role: 'user',
        type: 'message'
      },
      kind: 'public'
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
        command: 'monad project read | tail -100',
        cwd: '/tmp/project-agent',
        status: 'completed',
        aggregatedOutput: '{"messages":[{"text":"ok"}]}'
      }
    }
  };
  const entries = renderTimeline([
    {
      id: 'exa_codex0000000:json:0:tool-result',
      role: 'tool',
      text: JSON.stringify(raw.params.item),
      source: 'codex-app-server',
      providerEventType: 'function_call_output',
      raw,
      createdAt: '2026-07-03T06:28:03.751Z'
    } as never
  ]);

  expect(entries).toMatchObject([
    {
      card: {
        type: 'command-tool',
        view: {
          command: 'monad project read | tail -100',
          cwd: '/tmp/project-agent',
          output: '{"messages":[{"text":"ok"}]}',
          status: 'completed',
          type: 'commandExecution'
        }
      },
      kind: 'public',
      timestamp: '06:28:03'
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
      raw: {
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
    }
  ]);
  const claudeEntries = renderTimeline([
    {
      id: 'claude-call',
      role: 'tool',
      text: 'Tool call Bash',
      source: 'claude-code-sdk',
      providerEventType: 'tool_use',
      raw: {
        message: {
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git status' } }]
        }
      }
    },
    {
      id: 'claude-result',
      role: 'tool',
      text: 'On branch main',
      source: 'claude-code-sdk',
      providerEventType: 'tool_result',
      raw: { type: 'tool_result', output: 'On branch main' }
    }
  ]);

  expect(codexEntries).toMatchObject([{ kind: 'public', card: { type: 'command-tool' } }]);
  expect(claudeEntries).toMatchObject([{ kind: 'public', card: { type: 'command-tool' } }]);
});

test('observation card projection maps generic tool pairs to the shared command card', () => {
  const entries = renderTimeline([
    {
      id: 'call',
      role: 'tool',
      text: 'Tool call Search {"query":"monad"}',
      source: 'unknown',
      providerEventType: 'tool_use',
      raw: { name: 'Search' }
    },
    {
      id: 'result',
      role: 'tool',
      text: 'No results',
      source: 'unknown',
      providerEventType: 'tool_result',
      raw: { output: 'No results' }
    }
  ]);

  expect(entries).toMatchObject([{ kind: 'public', card: { type: 'command-tool' } }]);
});

test('observation timeline rows keep consecutive tool cards grouped for virtual rendering', () => {
  const entries = renderTimeline([
    {
      id: 'message-before',
      role: 'agent',
      text: 'Before tools',
      source: 'codex-app-server'
    },
    {
      id: 'call-one',
      role: 'tool',
      text: 'Tool call Search {"query":"monad"}',
      source: 'unknown',
      providerEventType: 'tool_use',
      raw: { name: 'Search' }
    },
    {
      id: 'result-one',
      role: 'tool',
      text: 'No results',
      source: 'unknown',
      providerEventType: 'tool_result',
      raw: { output: 'No results' }
    },
    {
      id: 'call-two',
      role: 'tool',
      text: 'Tool call Bash',
      source: 'unknown',
      providerEventType: 'tool_use',
      raw: { name: 'Bash' }
    },
    {
      id: 'result-two',
      role: 'tool',
      text: 'done',
      source: 'unknown',
      providerEventType: 'tool_result',
      raw: { output: 'done' }
    },
    {
      id: 'message-after',
      role: 'agent',
      text: 'After tools',
      source: 'codex-app-server'
    }
  ]);

  expect(observationTimelineRows(entries).map((row) => row.entries.length)).toEqual([1, 2, 1]);
});

test('observation card projection normalizes JSON-like generic tool output', () => {
  const entries = renderTimeline([
    {
      id: 'call',
      role: 'tool',
      text: 'Tool call Search {"query":"monad"}',
      source: 'codex-app-server',
      providerEventType: 'function_call',
      raw: { name: 'Search' }
    },
    {
      id: 'result',
      role: 'tool',
      text: '\n"{\\"ok\\":true}"\n',
      source: 'codex-app-server',
      providerEventType: 'function_call_output',
      raw: { output: '\n"{\\"ok\\":true}"\n' }
    }
  ]);

  expect(entries).toMatchObject([
    {
      kind: 'public',
      card: {
        type: 'command-tool',
        view: {
          commandLanguage: 'json',
          output: '{\n  "ok": true\n}',
          outputLanguage: 'json'
        }
      }
    }
  ]);
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
      raw: {
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
    }
  ]);

  expect(entries).toMatchObject([
    {
      kind: 'public',
      card: {
        type: 'command-tool',
        view: {
          output:
            '{\n  "content": [\n    {\n      "type": "text",\n      "text": "{\\"items\\":[{\\"message\\":{\\"role\\":\\"assistant\\",\\"text\\":\\"ok\\"}}],\\"seq\\":102}"\n    }\n  ]\n}',
          outputLanguage: 'json',
          type: 'tool-result'
        }
      }
    }
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
      raw: {
        message: {
          content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/example.tsx' } }]
        }
      }
    },
    {
      id: 'claude-read-result',
      role: 'tool',
      text: 'export function Example() { return <div />; }',
      source: 'claude-code-sdk',
      providerEventType: 'tool_result',
      raw: { type: 'tool_result', output: 'export function Example() { return <div />; }' }
    }
  ] as const;
  const entries = renderTimeline(items as never);

  expect(entries).toMatchObject([
    {
      kind: 'public',
      card: {
        type: 'file-read-tool',
        view: {
          content: 'export function Example() { return <div />; }',
          path: '/tmp/example.tsx',
          type: 'Read'
        }
      }
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

  const items = externalAgentStreamItems({ id: 'exa_claude000000', provider: 'claude-code', output });

  expect(items.map((item) => item.text)).toEqual([
    'init',
    'First response',
    'Result: success',
    'init',
    'Second response',
    'Result: success'
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
