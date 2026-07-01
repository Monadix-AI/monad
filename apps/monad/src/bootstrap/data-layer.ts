// Boot phase: the persistence layer — the embedded KV server (+ its loopback client and, in dev,
// the debug UI) and the SQLite store, with a startup repair pass. Returns the kv + store handles
// the rest of startDaemon threads everywhere; the KV server/client/logger stay internal (their only
// consumers are the exit/debug/trace hooks registered here).

import type { MonadPaths } from '@monad/home';
import type { KvService } from '@/services/kv.ts';

import { unlink } from 'node:fs/promises';
import { createLogger, logger } from '@monad/logger';

import { createKvService } from '@/services/kv.ts';
import { createStore, type Store } from '@/store/db/index.ts';
import { checkAndRepair } from '@/store/home/integrity.ts';
import { KvServer } from '@/store/kv/index.ts';

export async function createDataLayer(deps: {
  paths: MonadPaths;
  devMode: boolean;
}): Promise<{ kv: KvService; store: Store }> {
  const { paths, devMode } = deps;

  const kvServer = new KvServer();
  await unlink(paths.kvSock).catch(() => {});
  kvServer.start(paths.kvSock);
  // Bun.RedisClient connects lazily — probe once. If the Unix-socket URL can't be dialled (Bun rejects
  // `redis+unix://` on Windows even though the listener bound), rebind the server on TCP loopback and
  // reconnect, rather than letting every KV op fail. On POSIX the probe succeeds and this is a no-op.
  let kvClient = new Bun.RedisClient(kvServer.clientUrl);
  try {
    // Race a timeout: a bound-but-unspeakable socket could leave get() pending instead of rejecting,
    // and this probe gates the whole daemon boot. On POSIX the local empty-GET returns in microseconds
    // so the timer is cleared unused; only a genuine hang hits the 500 ms ceiling then falls back.
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
  process.on('exit', () => kvServer.stop());

  const kvLog = createLogger('kv');
  kvServer.onCommand((e) => kvLog.trace({ connId: e.connId, cmd: e.args[0], args: e.args.slice(1) }, 'cmd'));

  if (devMode) {
    const { startKvDebugServer } = await import('@/store/kv/debug-server.ts');
    const ui = startKvDebugServer(kvServer);
    logger.info(`dev: kv debug UI on ${ui.url}`);
    process.on('exit', () => ui.stop());
  }

  const store = createStore({ path: paths.db });

  // A crash/restart can leave assistant rows mid-stream (pending/streaming); their turn is gone and
  // can't resume, so fail them now or a reconnecting client would subscribe to a dead stream.
  const orphaned = store.failOrphanedStreamingMessages(new Date().toISOString());
  if (orphaned > 0) logger.warn(`monad: failed ${orphaned} interrupted in-flight message(s) from a previous run`);

  const report = await checkAndRepair(paths, store);
  if (report.auth === 'repaired') {
    logger.warn('monad: auth.json was rebuilt — credentials have been cleared');
  }

  return { kv, store };
}
