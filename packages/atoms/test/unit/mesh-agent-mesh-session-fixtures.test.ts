import type { MeshAgentProvider, MeshRawEventPage } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { meshRawEventPageSchema } from '@monad/protocol';

import { builtinAgentAdapters } from '../../src/agent-adapters/index.ts';
import { unsanitizedSemanticStrings } from '../../src/agent-adapters/observation-sanitize.ts';

type MeshProvider = 'codex' | 'claude-code';

async function fixture(provider: MeshProvider): Promise<{ provider: MeshAgentProvider; page: MeshRawEventPage }> {
  const raw = (await Bun.file(
    new URL(`../fixtures/mesh-agent-observation/${provider}-mesh.raw.json`, import.meta.url)
  ).json()) as Record<string, unknown>;
  return { provider: raw.provider as MeshAgentProvider, page: meshRawEventPageSchema.parse(raw.page) };
}

function adapterFor(provider: MeshProvider) {
  const adapter = builtinAgentAdapters.find((candidate) => candidate.provider === provider);
  if (!adapter?.events) throw new Error(`missing ${provider} event source`);
  return adapter.events;
}

function project(provider: MeshProvider, records: readonly unknown[]) {
  return adapterFor(provider).projectLive({
    id: `mesh-fixture-${provider}`,
    output: records.map((record) => JSON.stringify(record)).join('\n'),
    mode: 'events'
  }).events;
}

function firstByProviderEventType(provider: MeshProvider, page: MeshRawEventPage) {
  const seen = new Map<string, { role: string; source: string; text: string }>();
  for (const event of project(
    provider,
    page.records.map((record) => record.data)
  )) {
    const type = event.providerEventType ?? '';
    if (seen.has(type)) continue;
    seen.set(type, { role: event.role, source: event.source, text: String(event.text) });
  }
  return seen;
}

test('captured mesh-session fixtures are protocol-valid and carry no unsanitized semantic strings', async () => {
  const captured = await Promise.all([fixture('codex'), fixture('claude-code')]);

  expect(
    captured.map((item) => ({
      provider: item.provider,
      coverage: item.page.coverage,
      records: item.page.records.length,
      unsafe: unsanitizedSemanticStrings(item)
    }))
  ).toEqual([
    { provider: 'codex', coverage: 'settled', records: 86, unsafe: [] },
    { provider: 'claude-code', coverage: 'settled', records: 31, unsafe: [] }
  ]);
});

test('a real Codex mesh turn projects its recognised boundaries and falls back to system frames for the rest', async () => {
  const { page } = await fixture('codex');
  const byType = firstByProviderEventType('codex', page);

  expect({
    reasoning: byType.get('reasoning'),
    toolCall: byType.get('custom_tool_call'),
    turnStart: byType.get('turn-start'),
    sessionMeta: byType.get('session_meta'),
    worldState: byType.get('world_state'),
    turnContext: byType.get('turn_context'),
    interAgent: byType.get('inter_agent_communication_metadata')
  }).toEqual({
    reasoning: { role: 'agent', source: 'codex-exec', text: 'Thinking…' },
    toolCall: { role: 'tool', source: 'codex-exec', text: 'Tool call exec <text:40>' },
    turnStart: { role: 'system', source: 'codex-exec', text: 'Turn started' },
    // The rollout frames a mesh session adds around a turn have no projector of their own yet, so
    // they surface as opaque `unknown`-source system frames named after the record type. Locking
    // this in makes the day one of them gains real semantics a visible, reviewed change.
    sessionMeta: { role: 'system', source: 'unknown', text: 'session_meta' },
    worldState: { role: 'system', source: 'unknown', text: 'world_state' },
    turnContext: { role: 'system', source: 'unknown', text: 'turn_context' },
    interAgent: {
      role: 'system',
      source: 'unknown',
      text: 'inter_agent_communication_metadata'
    }
  });
});

test('a real Claude Code mesh turn projects user, thinking, tool, and terminal boundaries', async () => {
  const { page } = await fixture('claude-code');
  const byType = firstByProviderEventType('claude-code', page);

  expect({
    user: byType.get('user'),
    thinking: byType.get('thinking'),
    toolUse: byType.get('tool_use'),
    toolResult: byType.get('tool_result'),
    assistant: byType.get('assistant'),
    turnEnd: byType.get('turn-end'),
    attachment: byType.get('attachment'),
    queueOperation: byType.get('queue-operation')
  }).toEqual({
    user: { role: 'user', source: 'claude-code-sdk', text: '<text:3>' },
    thinking: { role: 'agent', source: 'claude-code-sdk', text: '<text:101>' },
    toolUse: { role: 'tool', source: 'claude-code-sdk', text: 'Tool call Bash {"command":"<text:104>"}' },
    toolResult: { role: 'tool', source: 'claude-code-sdk', text: '<text:105>' },
    assistant: { role: 'agent', source: 'claude-code-sdk', text: '<text:108>' },
    turnEnd: { role: 'system', source: 'claude-code-sdk', text: 'Turn completed' },
    attachment: { role: 'system', source: 'unknown', text: 'attachment' },
    queueOperation: { role: 'system', source: 'unknown', text: 'queue-operation' }
  });
});

test('incremental projection of a real mesh session equals whole-prefix projection at every record', async () => {
  for (const provider of ['codex', 'claude-code'] as const) {
    const { page } = await fixture(provider);
    const incremental = adapterFor(provider).createLiveProjector?.({ id: `mesh-fixture-${provider}` });
    if (!incremental) throw new Error(`missing ${provider} incremental projector`);
    const prefix: unknown[] = [];

    for (const record of page.records) {
      prefix.push(record.data);
      expect(incremental.advance(`${JSON.stringify(record.data)}\n`).events).toEqual(
        adapterFor(provider).projectLive({
          id: `mesh-fixture-${provider}`,
          output: prefix.map((item) => JSON.stringify(item)).join('\n')
        }).events
      );
    }
  }
});
