// WAL checkpoint scheduling for a file-backed Store. Split out of index.ts.

export interface CheckpointHandle {
  timer: ReturnType<typeof setInterval> | undefined;
  worker: Worker | undefined;
}

// Run WAL checkpoints in a Worker so the periodic fsync (which can stall 10-100ms on busy
// WAL files) does not block the daemon's main event loop mid-request. The worker is a pure
// optimization: if it can't be created or loaded — `new Worker(new URL(…, import.meta.url))`
// fails to resolve the embedded script in a bun --compile binary on some platforms (Windows),
// surfacing as "Worker has been terminated" — degrade silently. SQLite still auto-checkpoints
// the WAL at its page threshold, so correctness is unaffected; we only lose the offloaded fsync.
export function startWalCheckpoint(path: string): CheckpointHandle {
  const handle: CheckpointHandle = { timer: undefined, worker: undefined };
  try {
    const worker = new Worker(new URL('./workers/wal-checkpoint.ts', import.meta.url));
    worker.addEventListener('error', () => {
      handle.worker = undefined;
    });
    handle.worker = worker;
    handle.timer = setInterval(
      () => {
        try {
          handle.worker?.postMessage({ type: 'checkpoint', path });
        } catch {
          handle.worker = undefined;
        }
      },
      5 * 60 * 1000
    );
    handle.timer.unref();
  } catch {
    handle.worker = undefined;
  }
  return handle;
}

export function stopWalCheckpoint(handle: CheckpointHandle): void {
  if (handle.timer) {
    clearInterval(handle.timer);
    handle.timer = undefined;
  }
  handle.worker?.terminate();
  handle.worker = undefined;
}
