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
