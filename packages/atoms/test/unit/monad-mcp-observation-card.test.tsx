import type { AgentObservationCard, AgentObservationEvent } from '@monad/protocol';

import { expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { builtinAgentAdapters } from '../../src/agent-adapters/index.ts';
import { agentObservationCards } from '../../src/agent-adapters/observation-cards.ts';
import {
  MonadMcpToolCard,
  MonadMcpToolHeader
} from '../../src/workspace-experiences/chat-room/components/observation/monad-mcp-card.tsx';
import {
  type MonadMcpToolName,
  type MonadMcpToolView,
  monadMcpToolView
} from '../../src/workspace-experiences/chat-room/components/observation/monad-mcp-projection.ts';
import {
  ObservationTimelineRowView,
  observationTimelineEntries,
  observationTimelineRows
} from '../../src/workspace-experiences/chat-room/components/observation/timeline.tsx';
import { meshAgentNeutralStreamItems } from '../../src/workspace-experiences/experience/mesh-agent-observation/mesh-agent-observation.ts';

function toolEvent(args: {
  id: string;
  kind: 'tool-call' | 'tool-result';
  name: string;
  callId?: string;
  input?: unknown;
  output?: unknown;
  status?: string;
  durationMs?: number;
  text?: string;
}): AgentObservationEvent {
  return {
    id: args.id,
    kind: args.kind,
    streaming: false,
    ...(args.text === undefined ? {} : { text: args.text }),
    tool: {
      name: args.name,
      ...(args.callId === undefined ? {} : { callId: args.callId }),
      ...(args.input === undefined ? {} : { input: args.input }),
      ...(args.output === undefined ? {} : { output: args.output }),
      ...(args.status === undefined ? {} : { status: args.status }),
      ...(args.durationMs === undefined ? {} : { durationMs: args.durationMs })
    },
    provenance: { contractEvents: [{ id: args.id }] }
  };
}

const codexMonadEvidence = (tool: string) => [{ params: { item: { type: 'mcpToolCall', server: 'monad', tool } } }];

function visibleText(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function providerPipeline(provider: 'codex' | 'claude-code', records: readonly unknown[]) {
  const adapter = builtinAgentAdapters.find((candidate) => candidate.provider === provider);
  if (!adapter) throw new Error(`Missing ${provider} adapter`);
  const events = meshAgentNeutralStreamItems({
    id: `mesh_${provider.replaceAll('-', '_')}`,
    provider,
    adapter,
    output: records.map((record) => JSON.stringify(record)).join('\n')
  });
  const cards = agentObservationCards(events, provider);
  const entries = observationTimelineEntries(cards, provider);
  const markup = observationTimelineRows(entries).map((row) =>
    renderToStaticMarkup(React.createElement(ObservationTimelineRowView, { provider, row }))
  );
  return { cards, events, markup };
}

function pairedToolView(card: AgentObservationCard): MonadMcpToolView | null {
  const call = card.payload.call as AgentObservationEvent | undefined;
  const result = card.payload.result as AgentObservationEvent | undefined;
  return call && result ? monadMcpToolView(call, result, card.provenance.contractEvents) : null;
}

function timelineVisualRole(markup: string): 'error' | 'tool' | 'unknown' {
  const articleClass = /<article class="([^"]+)"/.exec(markup)?.[1] ?? '';
  if (articleClass.includes('border-destructive/45 bg-destructive/[0.06]')) return 'error';
  if (articleClass.includes('border-warning/40 bg-warning/[0.04]')) return 'tool';
  return 'unknown';
}

type MonadMcpCase = {
  toolName: MonadMcpToolName;
  input: unknown;
  action: Record<string, unknown>;
};

test('projects an actual Codex completed Monad MCP record through the semantic timeline', () => {
  const input = { text: 'Ready for review.', threadId: 'thread_1' };
  const output = {
    content: [{ type: 'text', text: 'Posted to the project.' }],
    structuredContent: { messageId: 'message_1', accepted: true },
    error: null,
    durationMs: 232
  };
  const raw = {
    method: 'item/completed',
    params: {
      item: {
        type: 'mcpToolCall',
        id: 'call_1',
        server: 'monad',
        tool: 'project_post',
        status: 'completed',
        arguments: input,
        result: output
      }
    }
  };

  const pipeline = providerPipeline('codex', [raw]);
  const card = pipeline.cards[0];
  if (!card) throw new Error('Expected Codex Monad MCP card');

  expect({
    events: pipeline.events.map(({ kind, tool }) => ({ kind, tool })),
    card: { kind: card.kind, streaming: card.streaming },
    view: pairedToolView(card),
    timeline: pipeline.markup.map((markup) => ({
      collapsed: markup.includes('aria-expanded="false"'),
      text: visibleText(markup),
      visualRole: timelineVisualRole(markup)
    }))
  }).toEqual({
    events: [
      {
        kind: 'tool-call',
        tool: { name: 'project_post', input, status: 'completed', durationMs: 232 }
      },
      {
        kind: 'tool-result',
        tool: { name: 'project_post', input, output, status: 'completed', durationMs: 232 }
      }
    ],
    card: { kind: 'tool', streaming: false },
    view: {
      toolName: 'project_post',
      status: 'completed',
      durationMs: 232,
      input,
      output,
      isError: false,
      action: 'project-post',
      text: 'Ready for review.',
      threadId: 'thread_1',
      attachments: []
    },
    timeline: [{ collapsed: true, text: 'Post to project Thread: thread_1 Completed 232ms', visualRole: 'tool' }]
  });
});

test('renders an actual completed Codex MCP error as an error without a contradictory completed status', () => {
  const input = { text: 'Post this update.' };
  const output = {
    content: [{ type: 'text', text: 'Permission denied.' }],
    structuredContent: null,
    error: { message: 'Permission denied.' },
    durationMs: 41
  };
  const raw = {
    method: 'item/completed',
    params: {
      item: {
        type: 'mcpToolCall',
        id: 'call_error',
        server: 'monad',
        tool: 'project_post',
        status: 'completed',
        arguments: input,
        result: output
      }
    }
  };

  const pipeline = providerPipeline('codex', [raw]);
  const card = pipeline.cards[0];
  const markup = pipeline.markup[0];
  if (!card || !markup) throw new Error('Expected Codex Monad MCP error card');

  expect({
    view: pairedToolView(card),
    timeline: {
      completed: visibleText(markup).includes('Completed'),
      text: visibleText(markup),
      visualRole: timelineVisualRole(markup)
    }
  }).toEqual({
    view: {
      toolName: 'project_post',
      status: 'completed',
      durationMs: 41,
      input,
      output,
      isError: true,
      action: 'project-post',
      text: 'Post this update.',
      attachments: []
    },
    timeline: { completed: false, text: 'Post to project Error 41ms', visualRole: 'error' }
  });
});

test('renders a completed rollout MCP Err result as a localized error card', () => {
  const input = { text: 'Retry this post.' };
  const call = toolEvent({
    id: 'rollout-call',
    kind: 'tool-call',
    name: 'project_post',
    callId: 'call_rollout_error',
    input
  });
  const result = toolEvent({
    id: 'rollout-result',
    kind: 'tool-result',
    name: 'project_post',
    callId: 'call_rollout_error',
    output: 'transport failed',
    status: 'completed'
  });
  const card: AgentObservationCard = {
    id: 'rollout-card',
    kind: 'tool',
    streaming: false,
    payload: { call, result },
    provenance: {
      contractEvents: [
        {
          data: {
            payload: {
              type: 'mcp_tool_call_end',
              invocation: { server: 'monad', tool: 'project_post' },
              result: { Err: 'transport failed' }
            }
          }
        }
      ]
    }
  };
  const row = observationTimelineRows(observationTimelineEntries([card], 'codex'))[0];
  if (!row) throw new Error('Expected rollout Monad MCP error row');
  const markup = renderToStaticMarkup(
    React.createElement(ObservationTimelineRowView, {
      provider: 'codex',
      row
    })
  );

  expect({
    view: pairedToolView(card),
    timeline: {
      completed: visibleText(markup).includes('Completed'),
      text: visibleText(markup),
      visualRole: timelineVisualRole(markup)
    }
  }).toEqual({
    view: {
      toolName: 'project_post',
      callId: 'call_rollout_error',
      status: 'completed',
      input,
      output: 'transport failed',
      isError: true,
      action: 'project-post',
      text: 'Retry this post.',
      attachments: []
    },
    timeline: { completed: false, text: 'Post to project Error', visualRole: 'error' }
  });
});

test('routes actual Claude Monad tool_use and matching tool_result records to a semantic card', () => {
  const input = { to: 'agent_alice', text: 'Please review the patch.' };
  const call = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_monad_1', name: 'mcp__monad__agent_send', input }]
    }
  };
  const result = {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_monad_1', content: 'Delivered.' }]
    }
  };

  const pipeline = providerPipeline('claude-code', [call, result]);
  const card = pipeline.cards[0];
  if (!card) throw new Error('Expected Claude Monad MCP card');

  expect({
    events: pipeline.events.map(({ kind, tool }) => ({ kind, tool })),
    view: pairedToolView(card),
    timeline: pipeline.markup.map((markup) => ({ text: visibleText(markup), visualRole: timelineVisualRole(markup) }))
  }).toEqual({
    events: [
      {
        kind: 'tool-call',
        tool: { name: 'mcp__monad__agent_send', input, callId: 'toolu_monad_1' }
      },
      {
        kind: 'tool-result',
        tool: { name: 'tool', output: 'Delivered.', callId: 'toolu_monad_1', status: 'completed' }
      }
    ],
    view: {
      toolName: 'agent_send',
      callId: 'toolu_monad_1',
      status: 'completed',
      input,
      output: 'Delivered.',
      isError: false,
      action: 'agent-send',
      to: 'agent_alice',
      text: 'Please review the patch.',
      attachments: []
    },
    timeline: [{ text: 'Send private message to agent_alice Recipient: agent_alice Completed', visualRole: 'tool' }]
  });
});

test('routes session member availability through the semantic Monad MCP card', () => {
  const input = {};
  const output = {
    members: [
      { id: 'builder', displayName: 'Builder', status: 'online' },
      { id: 'reviewer', displayName: 'Reviewer', status: 'offline' }
    ]
  };
  const pipeline = providerPipeline('codex', [
    {
      method: 'item/completed',
      params: {
        item: {
          type: 'mcpToolCall',
          id: 'call_members',
          server: 'monad',
          tool: 'session_members',
          status: 'completed',
          arguments: input,
          result: output
        }
      }
    }
  ]);
  const card = pipeline.cards[0];
  if (!card) throw new Error('Expected session members card');

  expect({
    view: pairedToolView(card),
    timeline: pipeline.markup.map((markup) => ({ text: visibleText(markup), visualRole: timelineVisualRole(markup) }))
  }).toEqual({
    view: {
      toolName: 'session_members',
      status: 'completed',
      input,
      output,
      isError: false,
      action: 'session-members'
    },
    timeline: [{ text: 'List session members Completed', visualRole: 'tool' }]
  });
});

test('keeps actual non-Monad and unpaired MCP lifecycle records on the generic timeline path', () => {
  const mismatched = providerPipeline('codex', [
    {
      method: 'item/completed',
      params: {
        item: {
          type: 'mcpToolCall',
          id: 'call_github',
          server: 'github',
          tool: 'project_post',
          status: 'completed',
          arguments: { text: 'Third-party payload.' },
          result: { content: [{ type: 'text', text: 'Accepted.' }], error: null }
        }
      }
    }
  ]);
  const unpaired = providerPipeline('codex', [
    {
      method: 'item/started',
      params: {
        item: {
          type: 'mcpToolCall',
          id: 'call_running',
          server: 'monad',
          tool: 'project_post',
          status: 'inProgress',
          arguments: { text: 'Still running.' }
        }
      }
    }
  ]);

  const mismatchedCard = mismatched.cards[0];
  const unpairedCard = unpaired.cards[0];
  if (!mismatchedCard || !unpairedCard) throw new Error('Expected generic MCP cards');

  expect({
    mismatched: {
      semanticView: pairedToolView(mismatchedCard),
      text: mismatched.markup.map(visibleText),
      visualRole: mismatched.markup.map(timelineVisualRole)
    },
    unpaired: {
      hasResult: unpairedCard.payload.result !== undefined,
      semanticView: pairedToolView(unpairedCard),
      text: unpaired.markup.map(visibleText),
      visualRole: unpaired.markup.map(timelineVisualRole)
    }
  }).toEqual({
    mismatched: {
      semanticView: null,
      text: ['tool call project_post completed'],
      visualRole: ['tool']
    },
    unpaired: {
      hasResult: false,
      semanticView: null,
      text: ['tool call project_post inProgress'],
      visualRole: ['tool']
    }
  });
});

test('projects an unprefixed Codex Monad call only with exact server and tool provenance', () => {
  const input = {
    text: 'I am investigating the failed deploy.',
    threadId: 'msg_123',
    attachments: [{ path: '/workspace/report.md', name: 'report.md', mime: 'text/markdown' }]
  };
  const output = { messageId: 'msg_124', accepted: true };
  const call = toolEvent({ id: 'call', kind: 'tool-call', name: 'project_post', callId: 'call_123', input });
  const result = toolEvent({
    id: 'result',
    kind: 'tool-result',
    name: 'project_post',
    output,
    status: 'completed',
    durationMs: 125
  });

  expect(monadMcpToolView(call, result, codexMonadEvidence('project_post'))).toEqual({
    toolName: 'project_post',
    callId: 'call_123',
    status: 'completed',
    durationMs: 125,
    input,
    output,
    isError: false,
    action: 'project-post',
    text: 'I am investigating the failed deploy.',
    threadId: 'msg_123',
    attachments: [{ path: '/workspace/report.md', name: 'report.md', mime: 'text/markdown' }]
  });
});

test('projects every Claude-prefixed Monad MCP tool into its exact semantic view', () => {
  const callId = 'call_456';
  const cases: MonadMcpCase[] = [
    {
      toolName: 'project_post',
      input: { text: 'Joined the project.', attachments: [{ path: '/workspace/status.md' }] },
      action: { action: 'project-post', text: 'Joined the project.', attachments: [{ path: '/workspace/status.md' }] }
    },
    {
      toolName: 'project_ask',
      input: { question: 'Which path?', options: ['Fast', 'Safe'], mode: 'single', allowOther: true },
      action: {
        action: 'project-ask',
        question: 'Which path?',
        options: ['Fast', 'Safe'],
        mode: 'single',
        allowOther: true
      }
    },
    {
      toolName: 'project_read',
      input: { threadId: 'msg_1', before: 'msg_2', after: 'msg_3', around: 'msg_4', limit: 20 },
      action: { action: 'project-read', threadId: 'msg_1', before: 'msg_2', after: 'msg_3', around: 'msg_4', limit: 20 }
    },
    { toolName: 'project_inbox_check', input: {}, action: { action: 'project-inbox-check' } },
    { toolName: 'project_inbox_ack', input: { cursor: 42 }, action: { action: 'project-inbox-ack', cursor: 42 } },
    {
      toolName: 'agent_send',
      input: {
        to: 'agent_alice',
        text: 'Can you review this?',
        attachments: [{ path: '/workspace/plan.md', mime: 'text/markdown' }]
      },
      action: {
        action: 'agent-send',
        to: 'agent_alice',
        text: 'Can you review this?',
        attachments: [{ path: '/workspace/plan.md', mime: 'text/markdown' }]
      }
    },
    {
      toolName: 'agent_read',
      input: { with: 'agent_alice', before: 'msg_5', after: 'msg_6', limit: 12 },
      action: { action: 'agent-read', with: 'agent_alice', before: 'msg_5', after: 'msg_6', limit: 12 }
    },
    { toolName: 'session_members', input: {}, action: { action: 'session-members' } },
    { toolName: 'runtime_info', input: {}, action: { action: 'runtime-info' } }
  ];

  for (const entry of cases) {
    const call = toolEvent({
      id: `call_${entry.toolName}`,
      kind: 'tool-call',
      name: `mcp__monad__${entry.toolName}`,
      callId,
      input: entry.input
    });
    const result = toolEvent({
      id: `result_${entry.toolName}`,
      kind: 'tool-result',
      name: `mcp__monad__${entry.toolName}`,
      output: { ok: true },
      status: 'completed',
      durationMs: 50
    });

    expect(monadMcpToolView(call, result, [])).toEqual({
      toolName: entry.toolName,
      callId,
      status: 'completed',
      durationMs: 50,
      input: entry.input,
      output: { ok: true },
      isError: false,
      ...entry.action
    } as unknown as MonadMcpToolView);
  }
});

test('normalizes result metadata and result-text output while retaining raw MCP errors', () => {
  const call = toolEvent({
    id: 'call',
    kind: 'tool-call',
    name: 'project_inbox_ack',
    callId: 'call_789',
    input: { cursor: 9 },
    status: 'running',
    durationMs: 10
  });
  const result = toolEvent({
    id: 'result',
    kind: 'tool-result',
    name: 'project_inbox_ack',
    text: 'cursor rejected',
    status: 'error',
    durationMs: 88
  });

  expect(
    monadMcpToolView(call, result, [
      {
        data: {
          payload: {
            type: 'mcp_tool_call_end',
            invocation: { server: 'monad', tool: 'project_inbox_ack' },
            result: { Ok: { isError: true, error: { message: 'cursor rejected' } } }
          }
        }
      }
    ])
  ).toEqual({
    toolName: 'project_inbox_ack',
    callId: 'call_789',
    status: 'error',
    durationMs: 88,
    input: { cursor: 9 },
    output: 'cursor rejected',
    isError: true,
    action: 'project-inbox-ack',
    cursor: 9
  });
});

test('rejects non-Monad and same-name non-Monad tools', () => {
  const githubCall = toolEvent({ id: 'github-call', kind: 'tool-call', name: 'mcp__github__project_post' });
  const githubResult = toolEvent({ id: 'github-result', kind: 'tool-result', name: 'mcp__github__project_post' });
  const sameNameCall = toolEvent({ id: 'same-call', kind: 'tool-call', name: 'project_post' });
  const sameNameResult = toolEvent({ id: 'same-result', kind: 'tool-result', name: 'project_post' });
  const unknownCall = toolEvent({ id: 'unknown-call', kind: 'tool-call', name: 'mcp__monad__project_delete' });
  const unknownResult = toolEvent({ id: 'unknown-result', kind: 'tool-result', name: 'mcp__monad__project_delete' });

  expect(monadMcpToolView(githubCall, githubResult, [])).toEqual(null);
  expect(
    monadMcpToolView(sameNameCall, sameNameResult, [
      { params: { item: { type: 'mcpToolCall', server: 'github', tool: 'project_post' } } }
    ])
  ).toEqual(null);
  expect(monadMcpToolView(sameNameCall, sameNameResult, codexMonadEvidence('agent_read'))).toEqual(null);
  expect(monadMcpToolView(unknownCall, unknownResult, [])).toEqual(null);
});

test('falls back to the generic card when a recognized Monad call has malformed input', () => {
  const call = toolEvent({
    id: 'call',
    kind: 'tool-call',
    name: 'mcp__monad__project_ask',
    input: 'unexpected input'
  });
  const result = toolEvent({ id: 'result', kind: 'tool-result', name: 'mcp__monad__project_ask' });

  expect(monadMcpToolView(call, result, [])).toEqual(null);
});

test('renders the project-post header and body as an exact semantic contract', () => {
  const call = toolEvent({
    id: 'call',
    kind: 'tool-call',
    name: 'mcp__monad__project_post',
    input: {
      requestId: 'request_should_not_render',
      text: 'The deployment is ready for review.',
      threadId: 'thread_42',
      attachments: [{ path: '/workspace/release.md', name: 'release.md', mime: 'text/markdown' }]
    }
  });
  const result = toolEvent({
    id: 'result',
    kind: 'tool-result',
    name: 'mcp__monad__project_post',
    output: { messageId: 'message_43', accepted: true },
    status: 'completed'
  });
  const view = monadMcpToolView(call, result, []);
  if (!view) throw new Error('Expected Monad project_post view');

  const markup = renderToStaticMarkup(
    React.createElement(
      'div',
      undefined,
      React.createElement(MonadMcpToolHeader, { view }),
      React.createElement(MonadMcpToolCard, { view })
    )
  );

  expect(visibleText(markup)).toEqual(
    'Post to project Thread: thread_42 Completed Message The deployment is ready for review. Thread thread_42 Attachments release.md (text/markdown) Result { "messageId": "message_43", "accepted": true }'
  );
  // presence-ok: semantic rendering must not expose request identifiers.
  expect(markup.includes('request_should_not_render')).toEqual(false);
});

test('renders the agent-send header and body as an exact semantic contract', () => {
  const call = toolEvent({
    id: 'call',
    kind: 'tool-call',
    name: 'mcp__monad__agent_send',
    input: {
      to: 'agent_alice',
      text: 'Please check the migration.',
      attachments: [{ path: '/workspace/migration.md', name: 'migration.md' }]
    }
  });
  const result = toolEvent({
    id: 'result',
    kind: 'tool-result',
    name: 'mcp__monad__agent_send',
    output: { delivered: true },
    status: 'running',
    durationMs: 48
  });
  const view = monadMcpToolView(call, result, []);
  if (!view) throw new Error('Expected Monad agent_send view');

  const markup = renderToStaticMarkup(
    React.createElement(
      'div',
      undefined,
      React.createElement(MonadMcpToolHeader, { view }),
      React.createElement(MonadMcpToolCard, { view })
    )
  );

  expect(visibleText(markup)).toEqual(
    'Send private message to agent_alice Recipient: agent_alice Running 48ms Recipient agent_alice Message Please check the migration. Attachments migration.md Result { "delivered": true }'
  );
});

test('routes only a paired Monad MCP card to a collapsed semantic timeline header', () => {
  const monadCall = toolEvent({
    id: 'monad-call',
    kind: 'tool-call',
    name: 'project_post',
    callId: 'monad_call_1',
    input: { text: 'Hidden until expanded.', threadId: 'thread_1' }
  });
  const monadResult = toolEvent({
    id: 'monad-result',
    kind: 'tool-result',
    name: 'project_post',
    callId: 'monad_call_1',
    output: { accepted: true },
    status: 'completed'
  });
  const genericCall = toolEvent({
    id: 'generic-call',
    kind: 'tool-call',
    name: 'project_post',
    callId: 'generic_call_1',
    input: { text: 'Third-party payload.' }
  });
  const genericResult = toolEvent({
    id: 'generic-result',
    kind: 'tool-result',
    name: 'project_post',
    callId: 'generic_call_1',
    output: { accepted: true }
  });
  const cards: AgentObservationCard[] = [
    {
      id: 'monad-card',
      kind: 'tool',
      streaming: false,
      payload: { call: monadCall, result: monadResult },
      provenance: {
        contractEvents: [{ params: { item: { type: 'mcpToolCall', server: 'monad', tool: 'project_post' } } }]
      }
    },
    {
      id: 'generic-card',
      kind: 'tool',
      streaming: false,
      payload: { call: genericCall, result: genericResult },
      provenance: {
        contractEvents: [{ params: { item: { type: 'mcpToolCall', server: 'github', tool: 'project_post' } } }]
      }
    }
  ];
  const rows = observationTimelineRows(observationTimelineEntries(cards, 'codex'));
  const markup = rows.map((row) =>
    renderToStaticMarkup(React.createElement(ObservationTimelineRowView, { provider: 'codex', row }))
  );

  expect(markup.map(visibleText)).toEqual([
    'Post to project Thread: thread_1 Completed',
    'tool call project_post running'
  ]);
});
