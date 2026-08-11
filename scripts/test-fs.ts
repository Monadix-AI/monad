import { rm } from 'node:fs/promises';

/** Windows keeps a directory locked until every handle into it is closed, and that outlasts the
 *  exit of the process that opened them — a teardown running immediately after sees EBUSY on a
 *  tree nothing is really using any more. Retry until the deadline rather than failing whichever
 *  test happened to tear down first.
 *
 *  Shared across packages: the retry is pure waste elsewhere, so non-Windows rethrows at once. */
export async function removeDirectory(path: string, { timeoutMs = 20_000 } = {}): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await rm(path, { force: true, recursive: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (process.platform !== 'win32' || !['EACCES', 'EBUSY', 'EFAULT', 'ENOTEMPTY', 'EPERM'].includes(code)) {
        throw error;
      }
      if (Date.now() >= deadline) throw error;
      await Bun.sleep(20);
    }
  }
}
