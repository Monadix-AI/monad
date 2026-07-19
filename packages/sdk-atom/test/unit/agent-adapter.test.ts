import type { MeshAgentEventSource, MeshAgentProviderEventContext } from '../../src/agent-adapter.ts';

import { expect, test } from 'bun:test';

test('MeshAgent event source returns raw and convenience views through one page contract', async () => {
  const source: MeshAgentEventSource = {
    projectLive: () => ({ events: [] }),
    readPage: async (_context, request) =>
      request.view === 'raw'
        ? { state: 'available', view: 'raw', records: [], coverage: 'exact', nextCursor: 'next' }
        : { state: 'available', view: 'convenience', events: [], nextCursor: 'next' }
  };
  const eventContext: MeshAgentProviderEventContext = {
    providerSessionRef: 'provider-session',
    workingPath: '/tmp/project',
    limitBytes: 1024
  };

  expect(await source.readPage?.(eventContext, { view: 'convenience', limit: 20 })).toEqual({
    state: 'available',
    view: 'convenience',
    events: [],
    nextCursor: 'next'
  });
  expect(await source.readPage?.(eventContext, { view: 'raw', limit: 20 })).toEqual({
    state: 'available',
    view: 'raw',
    records: [],
    coverage: 'exact',
    nextCursor: 'next'
  });
});
