import type { MonadPaths } from '@monad/environment';
import type { ConfigSnapshot } from '#/config/manager.ts';
import type { RuntimeModule } from '#/runtime/types.ts';
import type { KvService } from '#/services/kv.ts';
import type { KvDebugServer } from './kv/debug-server.ts';

import { unlink } from 'node:fs/promises';
import { createLogger, logger } from '@monad/logger';

import { createKvService } from '#/services/kv.ts';
import { createStore, type Store } from './db/index.ts';
import { checkAndRepair } from './home/integrity.ts';
import { KvServer } from './kv/index.ts';

export interface DataLayerOptions {
  paths: MonadPaths;
  devMode: boolean;
}

export interface DataLayer {
  kv: KvService;
  store: Store;
  stop(): Promise<void>;
}

export type StartDataLayer = (options: DataLayerOptions) => Promise<DataLayer>;

export interface DataLayerCleanup {
  stopDebug?: () => void;
  closeClient: () => void;
  stopServer: () => void;
  closeStore: () => void;
}

export function createDataLayerStop(resources: DataLayerCleanup): () => Promise<void> {
  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    const cleanup = [resources.stopDebug, resources.closeClient, resources.stopServer, resources.closeStore];
    let failure: unknown;
    for (const close of cleanup) {
      try {
        close?.();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  };
}

export async function createDataLayer(options: DataLayerOptions): Promise<DataLayer> {
  const { paths, devMode } = options;
  const kvServer = new KvServer();
  await unlink(paths.kvSock).catch(() => {});
  kvServer.start(paths.kvSock);

  let kvClient = new Bun.RedisClient(kvServer.clientUrl);
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('kv probe timeout')), 500);
    });
    try {
      await Promise.race([kvClient.get('__monad_kv_conn_probe__'), timeout]);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    kvClient.close();
    kvServer.bindTcpFallback();
    kvClient = new Bun.RedisClient(kvServer.clientUrl);
  }

  const kv = createKvService(kvServer, kvClient);
  const kvLog = createLogger('kv');
  kvServer.onCommand((event) =>
    kvLog.trace({ connId: event.connId, cmd: event.args[0], args: event.args.slice(1) }, 'cmd')
  );

  let debugServer: KvDebugServer | undefined;
  if (devMode) {
    const { startKvDebugServer } = await import('./kv/debug-server.ts');
    debugServer = startKvDebugServer(kvServer);
    logger.info(`dev: kv debug UI on ${debugServer.url}`);
  }

  const store = createStore({ path: paths.db });
  const orphaned = store.failOrphanedStreamingMessages(new Date().toISOString());
  if (orphaned > 0) logger.warn(`monad: failed ${orphaned} interrupted in-flight message(s) from a previous run`);

  const report = await checkAndRepair(paths, store);
  if (report.auth === 'repaired') {
    logger.warn('monad: auth.json was rebuilt — credentials have been cleared');
  }

  const stopResources = createDataLayerStop({
    ...(debugServer === undefined ? {} : { stopDebug: () => debugServer.stop() }),
    closeClient: () => kvClient.close(),
    stopServer: () => kvServer.stop(),
    closeStore: () => store.close()
  });
  const onExit = () => void stopResources();
  process.once('exit', onExit);

  return {
    kv,
    store,
    stop: async () => {
      process.off('exit', onExit);
      await stopResources();
    }
  };
}

export function createStoreLifecycleModule(
  options: DataLayerOptions,
  start: StartDataLayer = createDataLayer
): RuntimeModule<ConfigSnapshot> {
  return {
    id: 'store',
    criticality: 'required',
    start: () => start(options),
    stop: (current) => (current as DataLayer).stop()
  };
}
