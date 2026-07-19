// Observation Task 2: adapter raw acquisition. The app-server event source exposes the exact
// provider records (page.items) through the raw event view, before any projection — each record's
// `data` is verbatim and its provider `uuid` becomes the stable cursor/providerIdentity the raw and
// convenience streams key on. See docs/plans/2026-07-18-observation-dual-stream-implementation.md T2.

import type { AgentObservationEvent, MeshAgentObservationEvent } from '@monad/protocol';
import type {
  MeshAgentEventSource,
  MeshAgentObservationProjector,
  MeshAgentProviderEventContext
} from '@monad/sdk-atom';

import { expect, test } from 'bun:test';

import { codexMeshAgentAdapter } from '../../src/agent-adapters/codex/index.ts';
import { createAppServerEventSource, createOutputEventSource } from '../../src/agent-adapters/event-source.ts';
import { toAgentObservationEvent } from '../../src/agent-adapters/neutral-observation.ts';
import { observation } from '../../src/agent-adapters/observation-projection.ts';

const emptyProjection = { recordProjectors: [] } as unknown as MeshAgentObservationProjector;

function rawEventReader(source: MeshAgentEventSource) {
  const reader = source.readPage;
  if (!reader) throw new Error('expected a raw events reader');
  return reader;
}

// requestPage is only invoked inside context.requestProviderPage; the mock context below bypasses it.
function appServerSource() {
  return createAppServerEventSource({
    provider: 'codex',
    projection: emptyProjection,
    requestPage: () => 0
  });
}

function eventContext(items: unknown[], nextCursor?: string): MeshAgentProviderEventContext {
  return {
    providerSessionRef: 'ref-1',
    workingPath: '/tmp/ws',
    limitBytes: 1_000_000,
    requestProviderPage: async () => ({ items, ...(nextCursor ? { nextCursor } : {}) })
  };
}

const noPageContext: MeshAgentProviderEventContext = {
  providerSessionRef: 'ref-1',
  workingPath: '/tmp/ws',
  limitBytes: 1_000_000
};

test('raw event reader returns provider items verbatim with uuid as provider identity and cursor', async () => {
  const items = [
    { type: 'item/started', uuid: 'u1', payload: { text: 'hi' } },
    { type: 'item/completed', uuid: 'u2', nested: [1, { deep: true }] }
  ];
  const source = appServerSource();
  const result = await rawEventReader(source)(eventContext(items, 'next-7'), {
    view: 'raw',
    limit: 10
  });
  expect(result).toEqual({
    state: 'available',
    view: 'raw',
    records: [
      { data: items[1], cursor: 'u2', providerIdentity: 'u2' },
      { data: items[0], cursor: 'u1', providerIdentity: 'u1' }
    ],
    nextCursor: 'next-7',
    coverage: 'exact'
  });
});

test('raw event reader falls back to a positional cursor when a record has no provider identity', async () => {
  const items = [{ type: 'plain', text: 'no uuid here' }];
  const source = appServerSource();
  const result = await rawEventReader(source)(eventContext(items), {
    before: '5',
    view: 'raw',
    limit: 10
  });
  expect(result).toEqual({
    state: 'available',
    view: 'raw',
    records: [{ data: items[0], cursor: '5:0' }],
    coverage: 'exact'
  });
});

test('Codex raw events preserve stable provider-native turns when older turns are prepended', async () => {
  const turn = {
    id: 'turn-2',
    items: [
      { id: 'item-8', type: 'userMessage', text: 'second turn' },
      { type: 'agentMessage', text: 'reply' }
    ]
  };
  const reader = rawEventReader(codexMeshAgentAdapter.events);
  const first = await reader(eventContext([turn]), { view: 'raw', limit: 20 });
  const afterPrepend = await reader(eventContext([{ id: 'turn-1', items: [] }, turn]), {
    view: 'raw',
    limit: 20
  });

  expect(first).toEqual({
    state: 'available',
    view: 'raw',
    records: [{ data: turn, cursor: 'turn-2', providerIdentity: 'turn-2' }],
    coverage: 'exact'
  });
  expect(afterPrepend).toEqual({
    state: 'available',
    view: 'raw',
    records: [
      { data: turn, cursor: 'turn-2', providerIdentity: 'turn-2' },
      { data: { id: 'turn-1', items: [] }, cursor: 'turn-1', providerIdentity: 'turn-1' }
    ],
    coverage: 'exact'
  });
});

test('raw event reader reverses record order for a descending request', async () => {
  const items = [
    { uuid: 'a', n: 1 },
    { uuid: 'b', n: 2 }
  ];
  const source = appServerSource();
  const result = await rawEventReader(source)(eventContext(items), { view: 'raw', limit: 10 });
  if (result.state !== 'available' || result.view !== 'raw') throw new Error('expected a page');
  expect(result.records.map((r) => r.providerIdentity)).toEqual(['b', 'a']);
  expect(result.records.map((r) => r.data)).toEqual([items[1], items[0]]);
});

test('raw event reader reports unavailable when the provider cannot page', async () => {
  const source = appServerSource();
  const result = await rawEventReader(source)(noPageContext, { view: 'raw', limit: 10 });
  expect(result).toEqual({ state: 'unavailable', reason: 'unsupported' });
});

test('output event reader parses provider records with settled coverage', async () => {
  const output = '{"uuid":"r1","type":"message","text":"a"}\n{"uuid":"r2","type":"reasoning","text":"b"}';
  const source = createOutputEventSource({
    provider: 'codex',
    projection: emptyProjection,
    readOutput: () => output
  });
  const result = await rawEventReader(source)(noPageContext, { view: 'raw', limit: 10 });
  expect(result).toEqual({
    state: 'available',
    view: 'raw',
    records: [
      { data: { uuid: 'r2', type: 'reasoning', text: 'b' }, cursor: 'r2', providerIdentity: 'r2' },
      { data: { uuid: 'r1', type: 'message', text: 'a' }, cursor: 'r1', providerIdentity: 'r1' }
    ],
    coverage: 'settled'
  });
});

test('output event reader reports not-found when the provider output is absent', async () => {
  const source = createOutputEventSource({
    provider: 'codex',
    projection: emptyProjection,
    readOutput: () => null
  });
  const result = await rawEventReader(source)(noPageContext, { view: 'raw', limit: 10 });
  expect(result).toEqual({ state: 'unavailable', reason: 'not-found' });
});

// The seam GPT flagged in the Task 2 review: the exact raw record delivered on the raw plane must be
// the same one carried as provenance inside the convenience plane's neutral event, so a consumer can
// dedupe raw⇆convenience by provider identity/provenance.
const seamProjection = {
  recordProjectors: [
    {
      parse: ({ id, record, recordIndex }: { id: string; record: Record<string, unknown>; recordIndex: number }) =>
        observation({
          id: `${id}:${recordIndex}`,
          role: 'agent',
          text: typeof record.text === 'string' ? record.text : 'x',
          source: 'unknown',
          providerEventType: 'message',
          raw: record
        })
    }
  ]
} as unknown as MeshAgentObservationProjector;

test('the raw record delivered on the raw plane is the same record carried as convenience provenance', async () => {
  const output = '{"uuid":"r1","type":"message","text":"hello"}';
  const source = createOutputEventSource({
    provider: 'codex',
    projection: seamProjection,
    readOutput: () => output
  });
  const raw = await rawEventReader(source)(noPageContext, { view: 'raw', limit: 10 });
  if (raw.state !== 'available' || raw.view !== 'raw') throw new Error('expected a page');
  const firstRecord = raw.records[0];
  if (!firstRecord) throw new Error('expected a raw record');
  const rawRecord = firstRecord.data;

  const projected = source.projectLive({ id: 'ref-1', output, mode: 'events' }).events;
  const neutral = projected
    .map((event) => toAgentObservationEvent(event, seamProjection))
    .filter((event): event is AgentObservationEvent => event !== null);
  const firstNeutral = neutral[0];
  if (!firstNeutral) throw new Error('expected a neutral event');
  const carriedRaw = (firstNeutral.provenance.contractEvents[0] as MeshAgentObservationEvent).provenance.rawEvents[0];

  expect(rawRecord).toEqual({ uuid: 'r1', type: 'message', text: 'hello' });
  expect(carriedRaw).toEqual(rawRecord);
});
