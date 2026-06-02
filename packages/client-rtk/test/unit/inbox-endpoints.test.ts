import type { MonadClient } from '@monad/client';

import { expect, test } from 'bun:test';

import { createMonadStore, monadApi } from '../../src/index.ts';

type LooseEndpoint = {
  initiate: (arg?: unknown) => unknown;
};

type DispatchResult<T> = Promise<unknown> & {
  unwrap(): Promise<T>;
  unsubscribe?(): void;
};

function endpoint(name: string): LooseEndpoint {
  const value = (monadApi.endpoints as Record<string, LooseEndpoint | undefined>)[name];
  if (!value) throw new Error(`missing endpoint: ${name}`);
  return value;
}

function ok<T>(data: T): { data: T; error: null; status: number } {
  return { data, error: null, status: 200 };
}

test('Inbox read mutations send exact requests and refresh subscribed summary state', async () => {
  const requests: unknown[] = [];
  let summaryCalls = 0;
  const client = {
    treaty: {
      v1: {
        inbox: {
          summary: {
            get: async () => {
              summaryCalls++;
              return ok({ unreadCount: Math.max(0, 2 - summaryCalls), needsResponseCount: 1 });
            }
          },
          'read-all': {
            post: async () => {
              requests.push({ operation: 'read-all' });
              return ok({ readAt: '2026-07-22T00:00:00.000Z', count: 2 });
            }
          },
          unread: {
            post: async (body: unknown) => {
              requests.push({ operation: 'unread', body });
              return ok({ itemKeys: ['mention:msg_ABCDEF123456'] });
            }
          }
        }
      }
    }
  } as unknown as MonadClient;
  const store = createMonadStore({ client });
  const summary = store.dispatch(endpoint('getInboxSummary').initiate() as never) as DispatchResult<unknown>;
  await summary;

  const readAll = store.dispatch(endpoint('markAllInboxRead').initiate() as never) as DispatchResult<unknown>;
  const unread = store.dispatch(
    endpoint('markInboxUnread').initiate({ itemKeys: ['mention:msg_ABCDEF123456'] }) as never
  ) as DispatchResult<unknown>;

  expect({ readAll: await readAll.unwrap(), unread: await unread.unwrap(), requests }).toEqual({
    readAll: { readAt: '2026-07-22T00:00:00.000Z', count: 2 },
    unread: { itemKeys: ['mention:msg_ABCDEF123456'] },
    requests: [{ operation: 'read-all' }, { operation: 'unread', body: { itemKeys: ['mention:msg_ABCDEF123456'] } }]
  });
  await Bun.sleep(0);
  expect(summaryCalls).toBeGreaterThan(1);
  summary.unsubscribe?.();
});
