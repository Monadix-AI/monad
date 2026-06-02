export { waitFor } from '../../../scripts/test-wait.ts';

/** A resolve/promise pair for `readSSE`'s `onConnected` hook: await `ready` before triggering the
 *  work whose events the stream must not miss, instead of guessing at a fixed attach delay. */
export function connectionGate(): { ready: Promise<void>; onConnected: () => void } {
  let onConnected!: () => void;
  const ready = new Promise<void>((resolve) => {
    onConnected = resolve;
  });
  return { ready, onConnected };
}
