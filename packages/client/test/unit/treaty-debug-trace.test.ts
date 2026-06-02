import { afterEach, expect, test } from 'bun:test';

import { MonadClient } from '../../src/index.ts';

afterEach(() => {
  globalThis.__MONAD_DEBUG_TRACE__ = undefined;
});

test('treaty fetcher emits debug trace input and output records', async () => {
  const traces: unknown[] = [];
  globalThis.__MONAD_DEBUG_TRACE__ = (entry) => traces.push(entry);
  const client = new MonadClient({
    baseUrl: 'http://127.0.0.1:52749',
    treatyConfig: {
      fetcher: (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch
    }
  });

  await client.treaty.health.get();

  expect(traces).toHaveLength(2);
  expect(traces[0]).toMatchObject({ direction: 'input', layer: 'http' });
  expect(traces[1]).toMatchObject({ direction: 'output', layer: 'http', data: { status: 200, ok: true } });
});

test('treaty fetcher emits debug trace errors', async () => {
  const traces: unknown[] = [];
  globalThis.__MONAD_DEBUG_TRACE__ = (entry) => traces.push(entry);
  const client = new MonadClient({
    baseUrl: 'http://127.0.0.1:52749',
    treatyConfig: {
      fetcher: (async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch
    }
  });

  await client.treaty.health.get();

  expect(traces.at(-1)).toMatchObject({ direction: 'error', layer: 'http', data: { message: 'network down' } });
});

test('treaty fetcher records aborted requests as internal trace entries', async () => {
  const traces: unknown[] = [];
  globalThis.__MONAD_DEBUG_TRACE__ = (entry) => traces.push(entry);
  const controller = new AbortController();
  controller.abort();
  const client = new MonadClient({
    baseUrl: 'http://127.0.0.1:52749',
    treatyConfig: {
      fetcher: (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        init?.signal?.throwIfAborted();
        throw new Error('should not happen');
      }) as unknown as typeof fetch
    }
  });

  await client.treaty.health.get({ fetch: { signal: controller.signal } });

  expect(traces.at(-1)).toMatchObject({ direction: 'internal', layer: 'http', data: { aborted: true } });
  expect(traces).not.toContainEqual(expect.objectContaining({ direction: 'error' }));
});
