import { expect, test } from 'bun:test';

import type { ExternalAgentEventSource, ExternalAgentProviderHistoryContext } from '../../src/agent-adapter.ts';

test('external agent event source returns normalized pages through one contract', async () => {
  const source: ExternalAgentEventSource = {
    projectLive: () => ({ events: [] }),
    readPage: async () => ({ state: 'available', events: [], nextCursor: 'next' })
  };
  const historyContext: ExternalAgentProviderHistoryContext = {
    providerSessionRef: 'provider-session',
    workingPath: '/tmp/project',
    limitBytes: 1024
  };

  expect(await source.readPage?.(historyContext, { limit: 20, sortDirection: 'desc' })).toEqual({
    state: 'available',
    events: [],
    nextCursor: 'next'
  });
});
