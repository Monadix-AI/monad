import { expect, test } from 'bun:test';

import { builtinAgentAdapters } from '../../src/agent-adapters/index.ts';
import {
  configureExternalAgentObservationAdapterResolver,
  externalAgentStreamItems
} from '../../src/workspace-experiences/experience/external-agent-observation/external-agent-observation.ts';

configureExternalAgentObservationAdapterResolver((provider) =>
  builtinAgentAdapters.find((adapter) => adapter.provider === provider)
);

test('structured observation events do not fall back to host observedAt', () => {
  const output = JSON.stringify({
    method: 'item/agentMessage/delta',
    params: { delta: 'Streaming update' }
  });

  expect(
    externalAgentStreamItems({
      id: 'exa_codex',
      provider: 'codex',
      output,
      observedAt: '2026-07-05T09:00:00.000Z'
    })
  ).toMatchObject([
    {
      text: 'Streaming update',
      createdAt: undefined
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

  expect(externalAgentStreamItems({ id: 'exa_claude', provider: 'claude-code', output })).toMatchObject([
    {
      text: 'Timestamped user message',
      createdAt: '2026-07-05T08:07:54.056Z'
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

  expect(externalAgentStreamItems({ id: 'exa_codex', provider: 'codex', output })).toMatchObject([
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

  expect(externalAgentStreamItems({ id: 'exa_codex', provider: 'codex', output })).toMatchObject([
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

  expect(externalAgentStreamItems({ id: 'exa_claude', provider: 'claude-code', output })).toMatchObject([
    {
      providerEventType: 'raw_json',
      source: 'unknown'
    }
  ]);
});
