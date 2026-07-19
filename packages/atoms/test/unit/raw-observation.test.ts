// Observation Task 2: adapter raw acquisition. The app-server history source exposes the exact
// provider records (page.items) through `readRawHistoryPage`, before any projection — each record's
// `data` is verbatim and its provider `uuid` becomes the stable cursor/providerIdentity the raw and
// convenience streams key on. See docs/plans/2026-07-18-observation-dual-stream-implementation.md T2.

import type { AgentObservationEvent, ExternalAgentObservationEvent } from '@monad/protocol';
import type {
  ExternalAgentEventSource,
  ExternalAgentObservationProjector,
  ExternalAgentProviderHistoryContext
} from '@monad/sdk-atom';

import { expect, test } from 'bun:test';

import {
  createAppServerHistoryEventSource,
  createOutputHistoryEventSource
} from '../../src/agent-adapters/event-source.ts';
import { toAgentObservationEvent } from '../../src/agent-adapters/neutral-observation.ts';
import { observation } from '../../src/agent-adapters/observation-projection.ts';

const emptyProjection = { recordProjectors: [] } as unknown as ExternalAgentObservationProjector;

function rawHistoryReader(source: ExternalAgentEventSource) {
  const reader = source.readRawHistoryPage;
  if (!reader) throw new Error('expected a raw history reader');
  return reader;
}

// requestPage is only invoked inside context.requestProviderPage; the mock context below bypasses it.
function appServerSource() {
  return createAppServerHistoryEventSource({
    provider: 'codex',
    projection: emptyProjection,
    requestPage: () => 0
  });
}

function historyContext(items: unknown[], nextCursor?: string): ExternalAgentProviderHistoryContext {
  return {
    providerSessionRef: 'ref-1',
    workingPath: '/tmp/ws',
    limitBytes: 1_000_000,
    requestProviderPage: async () => ({ items, ...(nextCursor ? { nextCursor } : {}) })
  };
}

const noPageContext: ExternalAgentProviderHistoryContext = {
  providerSessionRef: 'ref-1',
  workingPath: '/tmp/ws',
  limitBytes: 1_000_000
};

test('readRawHistoryPage returns provider items verbatim with uuid as provider identity and cursor', async () => {
  const items = [
    { type: 'item/started', uuid: 'u1', payload: { text: 'hi' } },
    { type: 'item/completed', uuid: 'u2', nested: [1, { deep: true }] }
  ];
  const source = appServerSource();
  const result = await rawHistoryReader(source)(historyContext(items, 'next-7'), {
    limit: 10,
    sortDirection: 'asc'
  });
  expect(result).toEqual({
    records: [
      { data: items[0], cursor: 'u1', providerIdentity: 'u1' },
      { data: items[1], cursor: 'u2', providerIdentity: 'u2' }
    ],
    nextCursor: 'next-7',
    coverage: 'exact'
  });
});

test('readRawHistoryPage falls back to a positional cursor when a record has no provider identity', async () => {
  const items = [{ type: 'plain', text: 'no uuid here' }];
  const source = appServerSource();
  const result = await rawHistoryReader(source)(historyContext(items), {
    before: '5',
    limit: 10,
    sortDirection: 'asc'
  });
  expect(result).toEqual({
    records: [{ data: items[0], cursor: '5:0' }],
    coverage: 'exact'
  });
});

test('readRawHistoryPage reverses record order for a descending request', async () => {
  const items = [
    { uuid: 'a', n: 1 },
    { uuid: 'b', n: 2 }
  ];
  const source = appServerSource();
  const result = await rawHistoryReader(source)(historyContext(items), { limit: 10, sortDirection: 'desc' });
  if (!('records' in result)) throw new Error('expected a page');
  expect(result.records.map((r) => r.providerIdentity)).toEqual(['b', 'a']);
  expect(result.records.map((r) => r.data)).toEqual([items[1], items[0]]);
});

test('readRawHistoryPage reports unavailable when the provider cannot page', async () => {
  const source = appServerSource();
  const result = await rawHistoryReader(source)(noPageContext, { limit: 10, sortDirection: 'asc' });
  expect(result).toEqual({ state: 'unavailable', reason: 'unsupported' });
});

test('output-history readRawHistoryPage parses provider records with settled coverage', async () => {
  const output = '{"uuid":"r1","type":"message","text":"a"}\n{"uuid":"r2","type":"reasoning","text":"b"}';
  const source = createOutputHistoryEventSource({
    provider: 'codex',
    projection: emptyProjection,
    readOutput: () => output
  });
  const result = await rawHistoryReader(source)(noPageContext, { limit: 10, sortDirection: 'asc' });
  expect(result).toEqual({
    records: [
      { data: { uuid: 'r1', type: 'message', text: 'a' }, cursor: 'r1', providerIdentity: 'r1' },
      { data: { uuid: 'r2', type: 'reasoning', text: 'b' }, cursor: 'r2', providerIdentity: 'r2' }
    ],
    coverage: 'settled'
  });
});

test('output-history readRawHistoryPage reports not-found when the provider output is absent', async () => {
  const source = createOutputHistoryEventSource({
    provider: 'codex',
    projection: emptyProjection,
    readOutput: () => null
  });
  const result = await rawHistoryReader(source)(noPageContext, { limit: 10, sortDirection: 'asc' });
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
} as unknown as ExternalAgentObservationProjector;

test('the raw record delivered on the raw plane is the same record carried as convenience provenance', async () => {
  const output = '{"uuid":"r1","type":"message","text":"hello"}';
  const source = createOutputHistoryEventSource({
    provider: 'codex',
    projection: seamProjection,
    readOutput: () => output
  });
  const raw = await rawHistoryReader(source)(noPageContext, { limit: 10, sortDirection: 'asc' });
  if (!('records' in raw)) throw new Error('expected a page');
  const firstRecord = raw.records[0];
  if (!firstRecord) throw new Error('expected a raw record');
  const rawRecord = firstRecord.data;

  const projected = source.projectLive({ id: 'ref-1', output, mode: 'history' }).events;
  const neutral = projected
    .map((event) => toAgentObservationEvent(event, seamProjection))
    .filter((event): event is AgentObservationEvent => event !== null);
  const firstNeutral = neutral[0];
  if (!firstNeutral) throw new Error('expected a neutral event');
  const carriedRaw = (firstNeutral.provenance.contractEvents[0] as ExternalAgentObservationEvent).provenance
    .rawEvents[0];

  expect(rawRecord).toEqual({ uuid: 'r1', type: 'message', text: 'hello' });
  expect(carriedRaw).toEqual(rawRecord);
});
