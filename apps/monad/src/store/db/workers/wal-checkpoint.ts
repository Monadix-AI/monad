/**
 * WAL checkpoint worker — runs `PRAGMA wal_checkpoint(TRUNCATE)` in a separate
 * thread so the periodic fsync does not stall the daemon's event loop.
 *
 * Protocol (via postMessage):
 *   main → worker: { type: 'checkpoint', path: string }
 *   worker → main: { type: 'done', path: string, walPages: number, movedPages: number }
 *   worker → main: { type: 'error', path: string, message: string }
 */

import { Database } from 'bun:sqlite';

addEventListener('message', (ev: MessageEvent<{ type: 'checkpoint'; path: string }>) => {
  if (ev.data.type !== 'checkpoint') return;
  const { path } = ev.data;
  try {
    const db = new Database(path, { readonly: false, create: false });
    db.exec('PRAGMA synchronous = NORMAL');
    // Returns one row: { busy, log, checkpointed }
    const row = db.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as {
      busy: number;
      log: number;
      checkpointed: number;
    } | null;
    db.close();
    postMessage({ type: 'done', path, walPages: row?.log ?? 0, movedPages: row?.checkpointed ?? 0 });
  } catch (err) {
    postMessage({ type: 'error', path, message: String(err) });
  }
});
