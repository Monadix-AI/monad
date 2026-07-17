import type { ExternalAgentObservationProjector } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';

import { createProjectedEventSource } from '../../src/agent-adapters/event-source.ts';
import { builtinAgentAdapters } from '../../src/agent-adapters/index.ts';
import { observation } from '../../src/agent-adapters/observation-projection.ts';

const projection: ExternalAgentObservationProjector = {
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

test('projected event source gives live and history records the same stable identity', () => {
  const source = createProjectedEventSource({ provider: 'codex', projection });
  const output = JSON.stringify({ type: 'message', text: 'Hello' });

  expect(source.projectLive({ id: 'live', output }).events).toEqual([
    {
      id: 'live:0',
      dedupeKey: 'codex:99a3e357',
      projection: 'normalized',
      role: 'agent',
      text: 'Hello',
      source: 'unknown',
      providerEventType: 'message',
      raw: { type: 'message', text: 'Hello' }
    }
  ]);
  expect(source.projectLive({ id: 'history', output, mode: 'history' }).events[0]?.dedupeKey).toBe('codex:99a3e357');
});

test('projected event source preserves unrecognized provider records as unknown events', () => {
  const source = createProjectedEventSource({ provider: 'codex', projection });
  const raw = { method: 'future/provider/event', params: { value: 1 } };

  expect(source.projectLive({ id: 'live', output: JSON.stringify(raw) }).events).toEqual([
    {
      id: 'live:unknown:0',
      dedupeKey: 'codex:741d960e',
      projection: 'unknown',
      role: 'system',
      text: 'future/provider/event',
      source: 'unknown',
      providerEventType: 'future/provider/event',
      raw
    }
  ]);
});

test('projected event source passes history cursors through without interpreting them', async () => {
  const source = createProjectedEventSource({
    provider: 'codex',
    projection,
    readPage: async (_context, request) => ({
      state: 'available',
      events: [],
      nextCursor: request.before
    })
  });
  const context = { providerSessionRef: 'thread', workingPath: '/tmp/project', limitBytes: 1024 };

  expect(
    await source.readPage?.(context, { before: 'opaque-provider-cursor', limit: 20, sortDirection: 'desc' })
  ).toEqual({ state: 'available', events: [], nextCursor: 'opaque-provider-cursor' });
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
        dedupeKey: `${adapter.provider}:741d960e`,
        projection: 'unknown',
        role: 'system',
        text: 'future/provider/event',
        source: 'unknown',
        providerEventType: 'future/provider/event',
        raw
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
      id: 'exa_claude000000',
      output: records.map((record) => JSON.stringify(record)).join('\n')
    }).events
  ).toMatchObject([
    {
      id: 'exa_claude000000:thinking-tokens',
      providerEventType: 'thinking_tokens_delta',
      text: 'Thinking… · 1120 tokens',
      raw: records
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
    adapter.events.projectLive({ id: 'exa_claude000000', output }).events.map((event) => ({
      type: event.providerEventType,
      text: event.text
    }))
  ).toEqual([
    { type: 'thinking_tokens_delta', text: 'Thinking… · 80 tokens' },
    { type: 'tool_use', text: 'Tool call Bash {"command":"pwd"}' },
    { type: 'thinking_tokens_delta', text: 'Thinking… · 150 tokens' }
  ]);
});
