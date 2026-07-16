import type { MonadPaths } from '@monad/environment';
import type { KvService } from '#/services/kv.ts';
import type { Store } from '#/store/db/index.ts';
import type { DataLayer } from '#/store/lifecycle.ts';

import { expect, test } from 'bun:test';

import { RuntimeContext } from '#/runtime/context.ts';
import { createDataLayerStop, createStoreLifecycleModule } from '#/store/lifecycle.ts';

const paths = { home: '/home/monad' } as MonadPaths;
const context = new RuntimeContext();

function fakeLayer(stop: () => void | Promise<void> = () => {}): DataLayer {
  return { kv: {} as KvService, store: {} as Store, stop: async () => void (await stop()) };
}

test('starts the required store module with canonical options', async () => {
  const calls: Array<{ devMode: boolean; home: string }> = [];
  const layer = fakeLayer();
  const module = createStoreLifecycleModule({ paths, devMode: true }, async (options) => {
    calls.push({ devMode: options.devMode, home: options.paths.home });
    return layer;
  });

  const output = await module.start(context, new AbortController().signal);

  expect({ calls, criticality: module.criticality, id: module.id, output }).toEqual({
    calls: [{ devMode: true, home: paths.home }],
    criticality: 'required',
    id: 'store',
    output: layer
  });
});

test('stops the owned data layer through the module lifecycle', async () => {
  const events: string[] = [];
  const layer = fakeLayer(() => void events.push('closed'));
  const module = createStoreLifecycleModule({ paths, devMode: false }, async () => layer);

  await module.stop?.(layer, context);

  expect(events).toEqual(['closed']);
});

test('data layer cleanup is idempotent and dependency ordered', async () => {
  const events: string[] = [];
  const stop = createDataLayerStop({
    stopDebug: () => void events.push('debug'),
    closeClient: () => void events.push('client'),
    stopServer: () => void events.push('server'),
    closeStore: () => void events.push('store')
  });

  await stop();
  await stop();

  expect(events).toEqual(['debug', 'client', 'server', 'store']);
});

test('continues data layer cleanup after one resource fails', async () => {
  const events: string[] = [];
  const stop = createDataLayerStop({
    stopDebug: () => void events.push('debug'),
    closeClient: () => {
      events.push('client');
      throw new Error('client close failed');
    },
    stopServer: () => void events.push('server'),
    closeStore: () => void events.push('store')
  });

  await expect(stop()).rejects.toThrow('client close failed');
  await stop();

  expect(events).toEqual(['debug', 'client', 'server', 'store']);
});
