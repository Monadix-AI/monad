/** Poll `predicate` until it holds, then return. Throws with `message` once `timeoutMs` elapses, so a
 *  condition that never becomes true fails loudly instead of passing on a fixed sleep.
 *
 *  Shared across packages: waiting on the observable condition both removes the flake (a slow CI box
 *  no longer under-waits) and removes the dead time (a fast box no longer over-waits). */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 5_000, intervalMs = 1, message = 'condition was not met' } = {}
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`${message} (waited ${timeoutMs}ms)`);
    await Bun.sleep(intervalMs);
  }
}
