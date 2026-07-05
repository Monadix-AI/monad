import type { Store } from '@/store/db/index.ts';
import type { LiveDelegate } from './acp-delegate-types.ts';

import { createLogger } from '@monad/logger';

const log = createLogger('acp-delegate');

// NUL separator (created at runtime — never a literal NUL byte in source) so neither the session id
// nor the agent name can forge the key boundary.
const KEY_SEP = String.fromCharCode(0);
// One reusable delegate per (parent session, agent name). Module-level so it survives the tool being
// re-created on config hot-reload.
export const liveDelegates = new Map<string, LiveDelegate>();
// In-flight spawns, so two concurrent delegations to the same key share one adapter instead of racing
// to spawn two (one of which would leak).
export const pendingSpawns = new Map<string, Promise<LiveDelegate>>();

// Module-level store reference — set from createAcpDelegateTool so evictDelegate (which receives no
// deps) can call store methods. Hot-reload safe: re-registration replaces this with the same instance.
export let delegateStore: Store | undefined;
export function setDelegateStore(store: Store | undefined): void {
  delegateStore = store;
}

export const delegateKey = (sessionId: string, agent: string): string => `${sessionId}${KEY_SEP}${agent}`;
export const isAlive = (d: LiveDelegate): boolean => d.proc.exitCode === null && d.proc.signalCode === null;

// Thrown when a QUEUED prompt finds its delegate was evicted out from under it (a concurrent delegation
// to the same agent aborted, or the adapter exited) before the prompt got to run — runExternalAgent
// catches this specific signal and re-spawns a fresh delegate rather than driving a dead connection.
export class DelegateEvictedError extends Error {}

// Reap every resident adapter when the daemon exits, mirroring the spawned-process registry
// (tools/process.ts). The reuse model keeps adapters — and any MCP servers they spawned — alive between
// turns, so without this a daemon stop/crash would orphan them. Sync handler: proc.kill() is the reap.
process.on('exit', () => {
  for (const d of liveDelegates.values()) d.proc.kill();
});

// Tear a delegate down: drop it from the registry, cancel its idle timer, abort lingering terminals,
// close the connection, kill the adapter. Idempotent.
export function evictDelegate(key: string, reason: string): void {
  const d = liveDelegates.get(key);
  if (!d) return;
  liveDelegates.delete(key);
  if (d.idleTimer) clearTimeout(d.idleTimer);
  for (const t of d.terminals.values()) t.abort.abort();
  d.terminals.clear();
  try {
    d.conn.close();
  } catch {
    // already closed — fine
  }
  d.proc.kill();
  try {
    delegateStore?.closeAcpDelegate(key, new Date().toISOString(), reason);
  } catch (err) {
    log.warn({ key, reason, err }, 'failed to persist delegate eviction');
  }
  log.debug({ agent: d.spec.name, reason }, 'external ACP delegate evicted');
}

/** Kill + drop every live delegate spawned under a parent session — call on session delete/reset so a
 *  reused adapter never outlives the conversation that owns it. */
export function clearAcpDelegatesForSession(sessionId: string): void {
  const prefix = `${sessionId}${KEY_SEP}`;
  for (const key of liveDelegates.keys()) {
    if (key.startsWith(prefix)) evictDelegate(key, 'session ended');
  }
}
