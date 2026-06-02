import type { MonadClient } from '@monad/client';
import type { SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { createMonadStore, monadApi } from '../../src/index.ts';

type LooseEndpoint = {
  initiate: (arg?: unknown) => unknown;
};

function endpoint(name: string): LooseEndpoint {
  const value = (monadApi.endpoints as Record<string, LooseEndpoint | undefined>)[name];
  if (!value) throw new Error(`missing endpoint: ${name}`);
  return value;
}

function clientWithUiStream(streamUiEvents: MonadClient['streamUiEvents']): MonadClient {
  return {
    treaty: { v1: {}, health: { get: async () => ({ data: { status: 'ok', version: '1.0.0' }, error: null }) } },
    fetch: async () => new Response(null, { status: 404 }),
    subscribeControl: () => () => {},
    streamEvents: () => () => {},
    streamUiEvents
  } as unknown as MonadClient;
}

test('streamUiItems disposes immediately when its final subscriber leaves', async () => {
  let disposals = 0;
  const client = clientWithUiStream(() => () => {
    disposals++;
  });
  const store = createMonadStore({ client });
  const sessionId = 'ses_100000000000' as SessionId;
  const subscription = store.dispatch(endpoint('streamUiItems').initiate(sessionId) as never) as Promise<unknown> & {
    unsubscribe(): void;
  };
  await subscription;

  subscription.unsubscribe();
  await Bun.sleep(10);

  expect(disposals).toBe(1);
});
