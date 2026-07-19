import type { LiveMeshSession } from '#/services/mesh-agent/host/host-types.ts';
import type { MeshAgentProviderAdapter } from '#/services/mesh-agent/types.ts';

import { afterAll, beforeAll, expect, test } from 'bun:test';

import { MeshAgentEventPages } from '#/services/mesh-agent/host/event-pages.ts';
import { registerAgentAdapterImpl, unregisterAgentAdapterImpl } from '#/services/mesh-agent/index.ts';

// The projector numbers events by their position in the output it was handed — the same numbering the
// live projection uses — so a page must not reuse the live session's id namespace.
const adapter = {
  provider: 'event-pages-fixture',
  events: {
    projectLive: ({ id, output }: { id: string; output: string }) => ({
      events: output
        .split('\n')
        .filter(Boolean)
        .map((line, index) => ({
          id: `${id}:json:${index}:message`,
          projection: 'normalized' as const,
          role: 'agent' as const,
          text: line,
          source: 'json' as const,
          dedupeKey: `event-pages-fixture:${line}`,
          provenance: { rawEvents: [{ text: line }] }
        }))
    })
  },
  observation: {},
  observationRuntime: undefined,
  parseOutput: () => []
} as unknown as MeshAgentProviderAdapter;

beforeAll(() => registerAgentAdapterImpl(adapter));
afterAll(() => unregisterAgentAdapterImpl('event-pages-fixture' as never));

function pagesWithLiveRows(rows: Array<{ seq: number; payload: string }>, nextBefore?: number) {
  const live = {
    id: 'mesh_pages',
    provider: 'event-pages-fixture',
    adapter,
    observationEpoch: 'oep_pages',
    providerSessionRef: 'ref_pages',
    liveRawStore: {
      epoch: 'oep_pages',
      page: ({ before }: { before?: number }) => ({
        rows: rows
          .filter((row) => (before === undefined ? true : row.seq < before))
          .map((row) => ({ ...row, stream: 'stdout' as const, observedAt: '2026-07-18T01:00:00.000Z' })),
        ...(nextBefore !== undefined ? { nextBefore } : {})
      }),
      cursorBefore: (seq: number) => `live:oep_pages:${seq}`
    }
  } as unknown as LiveMeshSession;
  return new MeshAgentEventPages({
    live: new Map([[live.id, live]]),
    store: { getMeshSession: () => undefined },
    agents: async () => [],
    buildSpawnEnv: async () => ({}),
    outputPipeline: {}
  } as never);
}

test('an earlier convenience page projects into its own id namespace so it prepends instead of overwriting live rows', async () => {
  const pages = pagesWithLiveRows(
    [
      { seq: 1, payload: 'older-a\n' },
      { seq: 2, payload: 'older-b\n' }
    ],
    1
  );

  const page = await pages.convenienceEventsPage('mesh_pages', {
    limit: 20,
    before: 'live:oep_pages:3'
  });
  const frame = page.frames[0];
  const ids =
    frame?.kind === 'patch' ? frame.operations.map((op) => (op.op === 'upsert' ? op.event.id : op.eventId)) : [];

  expect({ ids, nextCursor: page.nextCursor }).toEqual({
    ids: ['mesh_pages@oep_pages:3:json:0:message', 'mesh_pages@oep_pages:3:json:1:message'],
    nextCursor: 'live:oep_pages:1'
  });
});

test('two successive earlier pages never reuse an event id', async () => {
  const pages = pagesWithLiveRows([{ seq: 1, payload: 'older\n' }]);

  const [first, second] = await Promise.all([
    pages.convenienceEventsPage('mesh_pages', { limit: 20, before: 'live:oep_pages:5' }),
    pages.convenienceEventsPage('mesh_pages', { limit: 20, before: 'live:oep_pages:9' })
  ]);
  const idOf = (page: Awaited<ReturnType<typeof pages.convenienceEventsPage>>) => {
    const frame = page.frames[0];
    return frame?.kind === 'patch' && frame.operations[0]?.op === 'upsert' ? frame.operations[0].event.id : null;
  };

  expect([idOf(first), idOf(second)]).toEqual([
    'mesh_pages@oep_pages:5:json:0:message',
    'mesh_pages@oep_pages:9:json:0:message'
  ]);
});

test('event page capacity is controlled only by row count', async () => {
  const requests: unknown[] = [];
  const live = {
    id: 'mesh_pages',
    provider: 'event-pages-fixture',
    adapter,
    observationEpoch: 'oep_pages',
    providerSessionRef: 'ref_pages',
    liveRawStore: {
      epoch: 'oep_pages',
      page: (request: unknown) => {
        requests.push(request);
        return {
          rows: [1, 2].map((seq) => ({
            seq,
            stream: 'stdout' as const,
            payload: 'x'.repeat(200_000),
            observedAt: '2026-07-18T01:00:00.000Z'
          }))
        };
      },
      cursorBefore: (seq: number) => `live:oep_pages:${seq}`
    }
  } as unknown as LiveMeshSession;
  const pages = new MeshAgentEventPages({
    live: new Map([[live.id, live]]),
    store: { getMeshSession: () => undefined }
  } as never);

  const page = await pages.rawEventsPage('mesh_pages', { limit: 2, before: 'live:oep_pages:3' });

  expect({ requests, recordCount: page.records.length }).toEqual({
    requests: [{ before: 3, limit: 2, sortDirection: 'desc' }],
    recordCount: 2
  });
});
