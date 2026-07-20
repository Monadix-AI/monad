import type { LiveMeshSession } from '#/services/mesh-agent/host/host-types.ts';
import type { MeshAgentProviderAdapter } from '#/services/mesh-agent/types.ts';

import { expect, test } from 'bun:test';

import { MeshAgentObservationResolver } from '#/services/mesh-agent/host/observation-resolve.ts';

const adapter = {
  provider: 'codex',
  events: { projectLive: () => ({ events: [] }) },
  observation: {},
  parseOutput: () => []
} as unknown as MeshAgentProviderAdapter;

function resolverWithRows(
  page: (request: { after?: number; before?: number; limit: number; maxBytes?: number; sortDirection: string }) => {
    rows: Array<{ seq: number; stream: 'stdout'; payload: string; observedAt: string }>;
    nextBefore?: number;
  }
) {
  const live = {
    id: 'mesh_observe',
    provider: 'codex',
    adapter,
    observationEpoch: 'oep_observe',
    liveRawStore: {
      page,
      cursorBefore: (seq: number) => `live:oep_observe:${seq}`
    }
  } as unknown as LiveMeshSession;
  const resolver = new MeshAgentObservationResolver({
    live: new Map([[live.id, live]]),
    store: {},
    agents: async () => [],
    buildSpawnEnv: async () => ({}),
    takeStructuredLines: () => '',
    dropStructuredBuffer: () => {}
  } as never);
  return { live, resolver };
}

test('live observation is rebuilt from the newest committed raw rows', () => {
  const requests: unknown[] = [];
  const { resolver } = resolverWithRows((request) => {
    requests.push(request);
    return {
      rows: [
        { seq: 7, stream: 'stdout', payload: 'seven\n', observedAt: '2026-07-18T01:00:07.000Z' },
        { seq: 8, stream: 'stdout', payload: 'eight\n', observedAt: '2026-07-18T01:00:08.000Z' }
      ],
      nextBefore: 7
    };
  });

  expect(resolver.observeRaw('mesh_observe')).toEqual({
    state: 'live',
    observationEpoch: 'oep_observe',
    frames: [
      {
        meshSessionId: 'mesh_observe',
        provider: 'codex',
        observationEpoch: 'oep_observe',
        origin: 'live',
        cursor: 'live:oep_observe:7',
        stream: 'stdout',
        data: 'seven\n',
        observedAt: '2026-07-18T01:00:07.000Z'
      },
      {
        meshSessionId: 'mesh_observe',
        provider: 'codex',
        observationEpoch: 'oep_observe',
        origin: 'live',
        cursor: 'live:oep_observe:8',
        stream: 'stdout',
        data: 'eight\n',
        observedAt: '2026-07-18T01:00:08.000Z'
      }
    ]
  });
  expect(requests).toEqual([{ limit: 2_000, maxBytes: 262_144, sortDirection: 'asc' }]);
});

test('live observation resumes with exact committed rows after the row cursor', () => {
  const requests: unknown[] = [];
  const { resolver } = resolverWithRows((request) => {
    requests.push(request);
    return {
      rows: [{ seq: 9, stream: 'stdout', payload: 'nine\n', observedAt: '2026-07-18T01:00:09.000Z' }]
    };
  });

  expect(resolver.observeRaw('mesh_observe', 8)).toEqual({
    state: 'live',
    observationEpoch: 'oep_observe',
    frames: [
      {
        meshSessionId: 'mesh_observe',
        provider: 'codex',
        observationEpoch: 'oep_observe',
        origin: 'live',
        cursor: 'live:oep_observe:9',
        stream: 'stdout',
        data: 'nine\n',
        observedAt: '2026-07-18T01:00:09.000Z'
      }
    ]
  });
  expect(requests).toEqual([{ after: 8, limit: 2_000, maxBytes: 262_144, sortDirection: 'asc' }]);
});

test('convenience ready anchors before its separately delivered bootstrap patch', () => {
  const liveRows = [
    { seq: 1, stream: 'stdout' as const, payload: 'one\n', observedAt: '2026-07-18T01:00:01.000Z' },
    { seq: 2, stream: 'stdout' as const, payload: 'two\n', observedAt: '2026-07-18T01:00:02.000Z' }
  ];
  const { live, resolver } = resolverWithRows((request) => {
    if (request.sortDirection === 'asc') {
      const after = request.after;
      const rows = after === undefined ? liveRows : liveRows.filter((row) => row.seq > after);
      return { rows: request.limit === 1 ? rows.slice(0, 1) : rows };
    }
    const before = request.before;
    const rows = before === undefined ? liveRows : liveRows.filter((row) => row.seq < before);
    return { rows };
  });
  live.adapter = {
    ...adapter,
    events: {
      projectLive: ({ output }: { output: string }) => ({
        events: output
          ? [
              {
                id: 'projected',
                role: 'agent',
                text: output.trim(),
                source: 'plain-text',
                provenance: { rawEvents: [output] }
              }
            ]
          : []
      })
    }
  } as unknown as MeshAgentProviderAdapter;

  const result = resolver.observeConvenience('mesh_observe');
  expect(result).toEqual({
    state: 'live',
    observationEpoch: 'oep_observe',
    frames: [
      { kind: 'ready', observationEpoch: 'oep_observe', cursor: 'live:oep_observe:0' },
      {
        kind: 'patch',
        cursor: 'live:oep_observe:2',
        operations: [
          {
            op: 'upsert',
            event: {
              dedupeKey: 'plain-text:eb5a4353:agent',
              id: 'projected',
              streaming: false,
              kind: 'assistant-message',
              text: 'one\ntwo',
              provenance: {
                contractEvents: [
                  {
                    id: 'projected',
                    role: 'agent',
                    text: 'one\ntwo',
                    source: 'plain-text',
                    provenance: { rawEvents: ['one\ntwo\n'] }
                  }
                ]
              }
            }
          }
        ]
      }
    ]
  });
});

test('convenience projection advances one retained projector with only newly committed rows', () => {
  const rows = [{ seq: 1, stream: 'stdout' as const, payload: 'one\n', observedAt: '2026-07-18T01:00:01.000Z' }];
  const advances: string[] = [];
  let creations = 0;
  const { live, resolver } = resolverWithRows((request) => {
    const selected =
      request.sortDirection === 'asc'
        ? rows.filter((row) => request.after === undefined || row.seq > request.after)
        : rows.filter((row) => request.before === undefined || row.seq < request.before);
    return { rows: request.limit === 1 ? selected.slice(0, 1) : selected };
  });
  live.adapter = {
    ...adapter,
    events: {
      projectLive: () => {
        throw new Error('whole projection must not run on the retained incremental path');
      },
      createLiveProjector: () => {
        creations += 1;
        let output = '';
        return {
          advance: (delta: string) => {
            advances.push(delta);
            output += delta;
            return {
              events: [
                {
                  id: 'projected',
                  role: 'agent',
                  text: output.trim(),
                  source: 'plain-text',
                  provenance: { rawEvents: [output] }
                }
              ]
            };
          }
        };
      }
    }
  } as unknown as MeshAgentProviderAdapter;

  const first = resolver.observeConvenience('mesh_observe');
  rows.push({ seq: 2, stream: 'stdout', payload: 'two\n', observedAt: '2026-07-18T01:00:02.000Z' });
  const second = resolver.observeConvenience('mesh_observe', 1);

  expect({
    creations,
    advances,
    firstCursor:
      first.state === 'live'
        ? first.frames.flatMap((frame) => ('cursor' in frame ? [frame.cursor] : [])).at(-1)
        : undefined,
    second: second.state === 'live' ? second.frames : []
  }).toEqual({
    creations: 1,
    advances: ['one\n', 'two\n'],
    firstCursor: 'live:oep_observe:1',
    second: [
      { kind: 'ready', observationEpoch: 'oep_observe', cursor: 'live:oep_observe:1' },
      {
        kind: 'patch',
        cursor: 'live:oep_observe:2',
        operations: [
          {
            op: 'upsert',
            event: {
              dedupeKey: 'plain-text:eb5a4353:agent',
              id: 'projected',
              streaming: false,
              kind: 'assistant-message',
              text: 'one\ntwo',
              provenance: {
                contractEvents: [
                  {
                    id: 'projected',
                    role: 'agent',
                    text: 'one\ntwo',
                    source: 'plain-text',
                    provenance: { rawEvents: ['one\ntwo\n'] }
                  }
                ]
              }
            }
          }
        ]
      }
    ]
  });
});

test('a convenience projection failure omits its patch without affecting raw delivery', () => {
  const row = { seq: 1, stream: 'stdout' as const, payload: 'one\n', observedAt: '2026-07-18T01:00:01.000Z' };
  const { live, resolver } = resolverWithRows((request) => ({
    rows: request.sortDirection === 'asc' || request.sortDirection === 'desc' ? [row] : []
  }));
  live.adapter = {
    ...adapter,
    events: {
      projectLive: () => {
        throw new Error('broken projector');
      },
      createLiveProjector: () => ({
        advance: () => {
          throw new Error('broken projector');
        }
      })
    }
  } as unknown as MeshAgentProviderAdapter;

  expect({
    raw: resolver.observeRaw('mesh_observe'),
    convenience: resolver.observeConvenience('mesh_observe')
  }).toEqual({
    raw: {
      state: 'live',
      observationEpoch: 'oep_observe',
      frames: [
        {
          meshSessionId: 'mesh_observe',
          provider: 'codex',
          observationEpoch: 'oep_observe',
          origin: 'live',
          cursor: 'live:oep_observe:1',
          stream: 'stdout',
          data: 'one\n',
          observedAt: '2026-07-18T01:00:01.000Z'
        }
      ]
    },
    convenience: {
      state: 'live',
      observationEpoch: 'oep_observe',
      frames: [{ kind: 'ready', observationEpoch: 'oep_observe', cursor: 'live:oep_observe:0' }]
    }
  });
});
