import { expect, test } from 'bun:test';

import { builtinAgentAdapters } from '../../src/agent-adapters/index.ts';
import {
  configureMeshAgentObservationAdapterResolver,
  meshAgentStreamItems
} from '../../src/workplace-experiences/experience/mesh-agent-observation/mesh-agent-observation.ts';

configureMeshAgentObservationAdapterResolver((provider) =>
  builtinAgentAdapters.find((adapter) => adapter.provider === provider)
);

test('structured observation events fall back to host observedAt', () => {
  const output = JSON.stringify({
    method: 'item/agentMessage/delta',
    params: { delta: 'Streaming update' }
  });

  expect(
    meshAgentStreamItems({
      id: 'mesh_codex0000000',
      provider: 'codex',
      output,
      observedAt: '2026-07-05T09:00:00.000Z'
    })
  ).toMatchObject([
    {
      text: 'Streaming update',
      createdAt: '2026-07-05T09:00:00.000Z'
    }
  ]);
});

test('live event projection carries host observedAt into Claude records without provider timestamps', () => {
  const adapter = builtinAgentAdapters.find((candidate) => candidate.provider === 'claude-code');
  const output = JSON.stringify({
    type: 'assistant',
    uuid: 'message_1',
    session_id: 'session_1',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Projected assistant message' }]
    }
  });

  expect(
    adapter?.events
      .projectLive({
        id: 'mesh_claude000000',
        output,
        observedAt: '2026-07-05T09:01:00.000Z'
      })
      .events.map(({ createdAt, role, text }) => ({ createdAt, role, text }))
  ).toEqual([
    {
      createdAt: '2026-07-05T09:01:00.000Z',
      role: 'agent',
      text: 'Projected assistant message'
    }
  ]);
});

test('structured observation events preserve provider timestamps when present', () => {
  const output = JSON.stringify({
    type: 'user',
    timestamp: '2026-07-05T08:07:54.056Z',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'Timestamped user message' }]
    }
  });

  expect(
    meshAgentStreamItems({ id: 'mesh_claude000000', provider: 'claude-code', output }).map(
      ({ createdAt, providerEventType, text }) => ({ createdAt, providerEventType, text })
    )
  ).toEqual([
    {
      createdAt: '2026-07-05T08:07:54.056Z',
      providerEventType: 'turn-start',
      text: 'Turn started'
    },
    {
      createdAt: '2026-07-05T08:07:54.056Z',
      providerEventType: 'user',
      text: 'Timestamped user message'
    }
  ]);
});

test('Codex app-server item lifecycle uses millisecond timestamps from the provider contract', () => {
  const output = [
    JSON.stringify({
      method: 'item/started',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_1',
        startedAtMs: 1_783_296_000_456,
        item: {
          type: 'commandExecution',
          id: 'item_1',
          command: 'bun test'
        }
      }
    }),
    JSON.stringify({
      method: 'item/completed',
      params: {
        threadId: 'thread_1',
        turnId: 'turn_1',
        completedAtMs: 1_783_296_005_789,
        item: {
          type: 'commandExecution',
          id: 'item_1',
          command: 'bun test',
          aggregatedOutput: 'pass'
        }
      }
    })
  ].join('\n');

  expect(meshAgentStreamItems({ id: 'mesh_codex0000000', provider: 'codex', output })).toMatchObject([
    {
      providerEventType: 'function_call',
      createdAt: '2026-07-06T00:00:00.456Z'
    },
    {
      providerEventType: 'function_call_output',
      createdAt: '2026-07-06T00:00:05.789Z'
    }
  ]);
});

test('Codex app-server turn lifecycle uses second timestamps from the provider contract', () => {
  const output = [
    JSON.stringify({
      method: 'turn/started',
      params: {
        turn: {
          startedAt: 1_783_296_000
        }
      }
    }),
    JSON.stringify({
      method: 'turn/completed',
      params: {
        turn: {
          completedAt: 1_783_296_005
        }
      }
    })
  ].join('\n');

  expect(meshAgentStreamItems({ id: 'mesh_codex0000000', provider: 'codex', output })).toMatchObject([
    {
      providerEventType: 'turn/started',
      createdAt: '2026-07-06T00:00:00.000Z'
    },
    {
      providerEventType: 'turn/completed',
      createdAt: '2026-07-06T00:00:05.000Z'
    }
  ]);
});

test('Codex full turn records use turn boundaries when message items omit timestamps', () => {
  const output = JSON.stringify({
    id: 'turn_1',
    items: [
      { type: 'userMessage', id: 'item_1', text: 'Question' },
      { type: 'reasoning', id: 'item_2', summary: ['Thinking'], content: [] },
      { type: 'agentMessage', id: 'item_3', text: 'Answer' }
    ],
    itemsView: 'full',
    status: 'completed',
    startedAt: 1_783_296_000,
    completedAt: 1_783_296_005
  });

  expect(
    meshAgentStreamItems({ id: 'mesh_codex0000000', provider: 'codex', output })
      .filter((event) => event.role === 'user' || event.providerEventType === 'item/agentMessage')
      .map(({ createdAt, role, text }) => ({ createdAt, role, text }))
  ).toEqual([
    { createdAt: '2026-07-06T00:00:00.000Z', role: 'user', text: 'Question' },
    { createdAt: '2026-07-06T00:00:05.000Z', role: 'agent', text: 'Answer' }
  ]);
});

test('provider-specific observation parsing does not run Codex app-server contracts for other providers', () => {
  const output = JSON.stringify({
    method: 'item/started',
    params: {
      startedAtMs: 1_783_296_000_456,
      item: {
        type: 'commandExecution',
        command: 'bun test'
      }
    }
  });

  expect(meshAgentStreamItems({ id: 'mesh_claude000000', provider: 'claude-code', output })).toMatchObject([
    {
      providerEventType: 'raw_json',
      source: 'unknown'
    }
  ]);
});
