import type { LiveExternalAgentSession } from '#/services/external-agent/host/host-types.ts';
import type { ExternalAgentProviderAdapter } from '#/services/external-agent/types.ts';

import { expect, test } from 'bun:test';

import { ExternalAgentObservationResolver } from '#/services/external-agent/host/observation-resolve.ts';

const adapter = {
  provider: 'codex',
  events: { projectLive: () => ({ events: [] }) },
  observation: {},
  parseOutput: () => []
} as unknown as ExternalAgentProviderAdapter;

function resolverWithRows(
  page: (request: { after?: number; before?: number; limit: number; maxBytes?: number; sortDirection: string }) => {
    rows: Array<{ seq: number; stream: 'stdout'; payload: string; observedAt: string }>;
    nextBefore?: number;
  }
) {
  const live = {
    id: 'exa_observe',
    provider: 'codex',
    adapter,
    observationEpoch: 'oep_observe',
    liveRawStore: {
      page,
      cursorBefore: (seq: number) => `live:oep_observe:${seq}`
    }
  } as unknown as LiveExternalAgentSession;
  const resolver = new ExternalAgentObservationResolver({
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

  expect(resolver.observe('exa_observe')).toEqual({
    state: 'live',
    externalAgentSessionId: 'exa_observe',
    provider: 'codex',
    observationEpoch: 'oep_observe',
    output: 'seven\neight\n',
    events: [],
    historyBefore: 'live:oep_observe:7',
    usageMeter: null,
    seq: 8,
    observedAt: '2026-07-18T01:00:08.000Z'
  });
  expect(requests).toEqual([{ limit: 2_000, maxBytes: 262_144, sortDirection: 'desc' }]);
});

test('live observation resumes with exact committed rows after the row cursor', () => {
  const requests: unknown[] = [];
  const { resolver } = resolverWithRows((request) => {
    requests.push(request);
    return {
      rows: [{ seq: 9, stream: 'stdout', payload: 'nine\n', observedAt: '2026-07-18T01:00:09.000Z' }]
    };
  });

  expect(resolver.observe('exa_observe', 8)).toEqual({
    state: 'live',
    externalAgentSessionId: 'exa_observe',
    provider: 'codex',
    observationEpoch: 'oep_observe',
    append: 'nine\n',
    seq: 9,
    observedAt: '2026-07-18T01:00:09.000Z'
  });
  expect(requests).toEqual([{ after: 8, limit: 2_000, maxBytes: 262_144, sortDirection: 'asc' }]);
});
