import type { MeshAgentAppServerTransport, MeshAgentLaunchMode } from '@monad/protocol';

import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type MeshAgentKillFn = (pid: number, signal: NodeJS.Signals) => void;
export type MeshAgentTreeKillFn = (pid: number) => void;

/** Non-pty launch mode to retry with when Bun's pty (`terminal:`) spawn throws — e.g. ConPTY
 *  unavailable on the host. `json-stream` is preferred (keeps stdin/stdout structured); `app-server`
 *  over the `stdio` transport (no socket/port setup needed) is the fallback for providers with no
 *  json-stream mode — but only when the adapter actually offers `stdio` (some app-server providers
 *  are `ws`-only, so falling back to a `stdio` launch for them would just throw `unsupported_capability`
 *  a step later, replacing the real pty error with a confusing one). `undefined` means the provider has
 *  no non-pty mode to degrade to — the caller should let the original pty error propagate. */
export function pickPtyFallbackLaunchMode(
  supportedLaunchModes: MeshAgentLaunchMode[],
  supportedAppServerTransports: MeshAgentAppServerTransport[] = []
): MeshAgentLaunchMode | undefined {
  if (supportedLaunchModes.includes('json-stream')) return 'json-stream';
  if (supportedLaunchModes.includes('app-server') && supportedAppServerTransports.includes('stdio')) {
    return 'app-server';
  }
  return undefined;
}

// Windows has no process groups, so a single kill only signals the leader and leaves the CLI's own
// child processes orphaned. taskkill /T /F terminates the whole tree.
function taskkillTree(pid: number): void {
  Bun.spawnSync(['taskkill', '/T', '/F', '/PID', String(pid)]);
}

function isMissingProcessError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ESRCH';
}

function killIfPresent(pid: number, signal: NodeJS.Signals, kill: MeshAgentKillFn): void {
  try {
    kill(pid, signal);
  } catch (error) {
    if (!isMissingProcessError(error)) throw error;
  }
}

export function killMeshAgentProcess(
  pid: number | undefined,
  signal: NodeJS.Signals = 'SIGTERM',
  kill: MeshAgentKillFn = process.kill,
  platform: NodeJS.Platform = process.platform,
  treeKill: MeshAgentTreeKillFn = taskkillTree
): void {
  if (pid === undefined || pid <= 0) return;
  if (platform === 'win32') {
    try {
      treeKill(pid);
      return;
    } catch {
      // taskkill unavailable — fall back to a direct pid kill (leader only)
    }
    killIfPresent(pid, signal, kill);
    return;
  }
  try {
    // Native-cli processes are spawned detached, so pid is its own group leader; negate to signal
    // the whole group (the CLI + anything it spawned).
    kill(-pid, signal);
    return;
  } catch (error) {
    if (isMissingProcessError(error)) return;
    // fall through to direct pid kill
  }
  killIfPresent(pid, signal, kill);
}

/** Reconciliation registry of detached MeshAgent pids, persisted so a crashed daemon can reap the
 *  children it orphaned. Missing/corrupt file → empty list (best-effort cleanup, never throws).
 *  Async (not sync fs) since this runs on every session spawn/exit and must not block the daemon's
 *  event loop for the duration of every other in-flight session's request handling. */
export async function readProcessRegistry(path: string | undefined): Promise<number[]> {
  if (!path) return [];
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) =>
        entry && typeof entry === 'object' && typeof (entry as { pid?: unknown }).pid === 'number'
          ? (entry as { pid: number }).pid
          : undefined
      )
      .filter((pid): pid is number => typeof pid === 'number');
  } catch {
    return [];
  }
}

export async function writeProcessRegistry(path: string | undefined, pids: number[]): Promise<void> {
  if (!path) return;
  if (pids.length === 0) {
    try {
      await unlink(path);
    } catch {
      /* registry already absent */
    }
    return;
  }
  const parent = dirname(path);
  try {
    if (!(await stat(parent)).isDirectory()) return;
  } catch {
    // parent doesn't exist yet — created below
  }
  await mkdir(parent, { recursive: true });
  await writeFile(path, JSON.stringify(pids.map((pid) => ({ pid }))));
}
