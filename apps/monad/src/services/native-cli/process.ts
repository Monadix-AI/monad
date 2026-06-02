export type NativeCliKillFn = (pid: number, signal: NodeJS.Signals) => void;
export type NativeCliTreeKillFn = (pid: number) => void;

// Windows has no process groups, so a single kill only signals the leader and leaves the CLI's own
// child processes orphaned. taskkill /T /F terminates the whole tree.
function taskkillTree(pid: number): void {
  Bun.spawnSync(['taskkill', '/T', '/F', '/PID', String(pid)]);
}

export function killNativeCliProcess(
  pid: number | undefined,
  signal: NodeJS.Signals = 'SIGTERM',
  kill: NativeCliKillFn = process.kill,
  platform: NodeJS.Platform = process.platform,
  treeKill: NativeCliTreeKillFn = taskkillTree
): void {
  if (pid === undefined || pid <= 0) return;
  if (platform === 'win32') {
    try {
      treeKill(pid);
      return;
    } catch {
      // taskkill unavailable — fall back to a direct pid kill (leader only)
    }
    kill(pid, signal);
    return;
  }
  try {
    // Native-cli processes are spawned detached, so pid is its own group leader; negate to signal
    // the whole group (the CLI + anything it spawned).
    kill(-pid, signal);
    return;
  } catch {
    // fall through to direct pid kill
  }
  kill(pid, signal);
}
