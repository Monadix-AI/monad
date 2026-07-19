import type { MeshAgentProvider, MeshRawEventPage } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { meshRawEventPageSchema } from '@monad/protocol';

import { builtinAgentAdapters } from '../../src/agent-adapters/index.ts';

interface RealObservationFixture {
  provider: MeshAgentProvider;
  page: MeshRawEventPage;
}

const structuralStringKeys = new Set([
  'coverage',
  'event',
  'kind',
  'level',
  'method',
  'name',
  'op',
  'origin',
  'overageStatus',
  'overage_status',
  'phase',
  'provider',
  'rateLimitType',
  'rate_limit_type',
  'role',
  'state',
  'status',
  'stop_reason',
  'stream',
  'subtype',
  'type'
]);

async function fixture(provider: 'codex' | 'claude-code'): Promise<RealObservationFixture> {
  const raw = (await Bun.file(
    new URL(`../fixtures/mesh-agent-observation/${provider}.raw.json`, import.meta.url)
  ).json()) as Record<string, unknown>;
  return {
    provider: raw.provider as MeshAgentProvider,
    page: meshRawEventPageSchema.parse(raw.page)
  };
}

function unsafeSemanticStrings(value: unknown, key = '', path = '$'): string[] {
  if (typeof value === 'string') {
    if (structuralStringKeys.has(key)) return [];
    if (/^<(?:id|path|secret|text):\d+>$/.test(value)) return [];
    if (/^2000-01-01T00:00:00\.\d{3}Z$/.test(value)) return [];
    return [`${path}=${value}`];
  }
  if (Array.isArray(value))
    return value.flatMap((item, index) => unsafeSemanticStrings(item, key, `${path}[${index}]`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([childKey, child]) =>
    unsafeSemanticStrings(child, childKey, `${path}.${childKey}`)
  );
}

function project(provider: 'codex' | 'claude-code', records: unknown[]) {
  const adapter = builtinAgentAdapters.find((candidate) => candidate.provider === provider);
  if (!adapter?.events) throw new Error(`missing ${provider} event source`);
  return adapter.events.projectLive({
    id: `fixture-${provider}`,
    output: records.map((record) => JSON.stringify(record)).join('\n'),
    mode: 'events'
  }).events;
}

test('captured Codex and Claude raw-history fixtures are protocol-valid and contain no unsanitized semantic strings', async () => {
  const fixtures = await Promise.all([fixture('codex'), fixture('claude-code')]);

  expect(
    fixtures.map((item) => ({
      provider: item.provider,
      coverage: item.page.coverage,
      records: item.page.records.length,
      unsafe: unsafeSemanticStrings(item)
    }))
  ).toEqual([
    { provider: 'codex', coverage: 'settled', records: 24, unsafe: [] },
    { provider: 'claude-code', coverage: 'settled', records: 24, unsafe: [] }
  ]);
});

test('captured Codex response items project reasoning and custom tool boundaries', async () => {
  const { page } = await fixture('codex');
  const wanted = new Set(['reasoning', 'custom_tool_call', 'custom_tool_call_output']);
  const records = page.records
    .map((record) => record.data)
    .filter((record) => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
      const payload = (record as Record<string, unknown>).payload;
      return (
        !!payload && typeof payload === 'object' && wanted.delete(String((payload as Record<string, unknown>).type))
      );
    });

  expect(
    project('codex', records).map(({ role, source, providerEventType, text }) => ({
      role,
      source,
      providerEventType,
      text
    }))
  ).toEqual([
    { role: 'agent', source: 'codex-exec', providerEventType: 'reasoning', text: 'Thinking…' },
    {
      role: 'tool',
      source: 'codex-exec',
      providerEventType: 'custom_tool_call',
      text: 'Tool call exec <text:4>'
    },
    {
      role: 'tool',
      source: 'codex-exec',
      providerEventType: 'custom_tool_call_output',
      text: '[{"type":"input_text","text":"<text:5>"},{"type":"input_text","text":"<text:6>"}]'
    }
  ]);
});

test('captured Claude records project user, thinking, tool, result, assistant, and system boundaries', async () => {
  const { page } = await fixture('claude-code');
  const wanted = new Set(['user', 'thinking', 'tool_use', 'tool_result', 'text', 'system']);
  const records = page.records
    .map((record) => record.data)
    .filter((record) => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
      const value = record as Record<string, unknown>;
      const message =
        value.message && typeof value.message === 'object' ? (value.message as Record<string, unknown>) : {};
      const content = Array.isArray(message.content) ? message.content[0] : undefined;
      const contentType =
        content && typeof content === 'object' ? (content as Record<string, unknown>).type : undefined;
      const boundary =
        value.type === 'system'
          ? 'system'
          : value.type === 'user' && contentType !== 'tool_result'
            ? 'user'
            : (contentType ?? value.type);
      return wanted.delete(String(boundary));
    });

  expect(
    project('claude-code', records).map(({ role, source, providerEventType, text }) => ({
      role,
      source,
      providerEventType,
      text
    }))
  ).toEqual([
    { role: 'system', source: 'claude-code-sdk', providerEventType: 'turn-start', text: 'Turn started' },
    { role: 'user', source: 'claude-code-sdk', providerEventType: 'user', text: '<text:1>' },
    { role: 'agent', source: 'claude-code-sdk', providerEventType: 'thinking', text: '<text:3>' },
    {
      role: 'tool',
      source: 'claude-code-sdk',
      providerEventType: 'tool_use',
      text: 'Tool call ToolSearch {"query":"<text:7>","max_results":5}'
    },
    { role: 'tool', source: 'claude-code-sdk', providerEventType: 'tool_result', text: '<text:8>' },
    { role: 'agent', source: 'claude-code-sdk', providerEventType: 'assistant', text: '<text:17>' },
    { role: 'system', source: 'unknown', providerEventType: 'system', text: 'system' }
  ]);
});

test('incremental projectors match whole-prefix projection for every captured Codex and Claude record', async () => {
  for (const provider of ['codex', 'claude-code'] as const) {
    const { page } = await fixture(provider);
    const adapter = builtinAgentAdapters.find((candidate) => candidate.provider === provider);
    if (!adapter?.events) throw new Error(`missing ${provider} event source`);
    const incremental = adapter.events.createLiveProjector?.({ id: `fixture-${provider}` });
    if (!incremental) throw new Error(`missing ${provider} incremental projector`);
    const prefix: unknown[] = [];

    for (const record of page.records) {
      prefix.push(record.data);
      expect(incremental.advance(`${JSON.stringify(record.data)}\n`).events).toEqual(
        adapter.events.projectLive({
          id: `fixture-${provider}`,
          output: prefix.map((item) => JSON.stringify(item)).join('\n')
        }).events
      );
    }
  }
});
