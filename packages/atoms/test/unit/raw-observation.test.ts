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

import { createOutputEventSource } from '../../src/agent-adapters/event-source.ts';
import { toAgentObservationEvent } from '../../src/agent-adapters/neutral-observation.ts';
import { observation } from '../../src/agent-adapters/observation-projection.ts';

const emptyProjection = { recordProjectors: [] } as unknown as MeshAgentObservationProjector;

function rawEventReader(source: MeshAgentEventSource) {
  const reader = source.readPage;
  if (!reader) throw new Error('expected a raw events reader');
  return reader;
}

const noPageContext: MeshAgentProviderEventContext = {
  providerSessionRef: 'ref-1',
  workingPath: '/tmp/ws'
};

test('output event reader returns provider records oldest-first with settled coverage', async () => {
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
      { data: { uuid: 'r1', type: 'message', text: 'a' }, cursor: 'r1', providerIdentity: 'r1' },
      { data: { uuid: 'r2', type: 'reasoning', text: 'b' }, cursor: 'r2', providerIdentity: 'r2' }
    ],
    coverage: 'settled'
  });
});

test('output event reader keys Codex rollout records by turn and turn-local index', async () => {
  const turnId = 'turn-019f';
  const records = [
    { type: 'turn_context', payload: { turn_id: turnId } },
    { type: 'response_item', payload: { type: 'reasoning' } },
    { type: 'event_msg', payload: { type: 'token_count' } }
  ];
  const source = createOutputEventSource({
    provider: 'codex',
    projection: emptyProjection,
    readOutput: () => records.map((record) => JSON.stringify(record)).join('\n')
  });

  const result = await rawEventReader(source)(noPageContext, { view: 'raw', limit: 10 });

  expect(result).toEqual({
    state: 'available',
    view: 'raw',
    records: [
      { data: records[0], cursor: `${turnId}:0`, providerIdentity: `${turnId}:0` },
      { data: records[1], cursor: `${turnId}:1`, providerIdentity: `${turnId}:1` },
      { data: records[2], cursor: `${turnId}:2`, providerIdentity: `${turnId}:2` }
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
