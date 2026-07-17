import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { roleExecPath } from '@monad/environment';

interface DaemonChildProcessEntry {
  pid: number;
  label: string;
}

interface LiveDaemonChildProcessEntry extends DaemonChildProcessEntry {
  kill?: () => void;
}

interface KillDaemonProcessTreeDeps {
  platform?: NodeJS.Platform;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  spawnSync?: (argv: string[]) => void;
}

export interface DaemonChildSupervisorArgvOptions {
  execPath?: string;
  entryPath?: string;
  parentPid: number;
  registryPath: string;
}

interface RunDaemonChildSupervisorOptions {
  parentPid: number;
  registryPath: string;
  isPidAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  killTree?: (pid: number) => void;
}

interface StartCrashSupervisorDeps {
  platform?: NodeJS.Platform;
  spawn?: typeof Bun.spawn;
}

interface DaemonChildProcessRegistryConfigureOptions {
  supervisorEntryPath?: string;
}

const SUPERVISOR_ARG = '--daemon-child-supervisor';

export function killDaemonProcessTree(pid: number, deps: KillDaemonProcessTreeDeps = {}): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const platform = deps.platform ?? process.platform;
  const kill = deps.kill ?? process.kill;
  const spawnSync =
    deps.spawnSync ??
    ((argv) => {
      Bun.spawnSync(argv, { stdout: 'ignore', stderr: 'ignore' });
    });
  try {
    if (platform === 'win32') {
      spawnSync(['taskkill', '/T', '/F', '/PID', String(pid)]);
      return;
    }
    kill(-pid, 'SIGTERM');
    return;
  } catch {
    // The child may not be a process-group leader, or it may already be gone. Fall back to the pid.
  }
  try {
    kill(pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
}

export function daemonChildSupervisorArgv(options: DaemonChildSupervisorArgvOptions): string[] {
  const execPath = options.execPath ?? process.execPath;
  const entryPath = options.entryPath ?? process.argv[1];
  // roleExecPath falls back to execPath by itself when no monad-watchdog sibling was built (dev, or
  // an install predating this) — independent of whether entryPath needs to be re-passed below.
  const argv = [roleExecPath(execPath, 'watchdog')];
  if (entryPath && entryPath !== execPath) argv.push(entryPath);
  argv.push(SUPERVISOR_ARG, String(options.parentPid), options.registryPath);
  return argv;
}

export function daemonChildSupervisorLauncherArgv(
  supervisorArgv: string[],
  platform: NodeJS.Platform = process.platform
): string[] {
  if (platform === 'win32') return supervisorArgv;
  return ['/bin/sh', '-c', 'nohup "$@" >/dev/null 2>&1 &', 'daemon-child-supervisor', ...supervisorArgv];
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isDaemonChildSupervisorInvocation(argv: string[] = process.argv): boolean {
  return argv.includes(SUPERVISOR_ARG);
}

export async function runDaemonChildSupervisor(options: RunDaemonChildSupervisorOptions): Promise<void> {
  const alive = options.isPidAlive ?? isPidAlive;
  const sleep = options.sleep ?? Bun.sleep;
  const killTree = options.killTree ?? killDaemonProcessTree;

  while (alive(options.parentPid)) await sleep(500);

  const entries = readPersistedEntries(options.registryPath);
  for (const entry of entries) killTree(entry.pid);
  try {
    unlinkSync(options.registryPath);
  } catch {
    /* already absent */
  }
}

export async function runDaemonChildSupervisorFromArgv(argv: string[] = process.argv): Promise<boolean> {
  const index = argv.indexOf(SUPERVISOR_ARG);
  if (index === -1) return false;
  const parentPid = Number(argv[index + 1]);
  const registryPath = argv[index + 2];
  if (!Number.isInteger(parentPid) || parentPid <= 0 || !registryPath) return true;
  await runDaemonChildSupervisor({ parentPid, registryPath });
  return true;
}

function isLiveEntry(value: unknown): value is DaemonChildProcessEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { pid?: unknown }).pid === 'number' &&
    typeof (value as { label?: unknown }).label === 'string'
  );
}

function readPersistedEntries(path: string | undefined): DaemonChildProcessEntry[] {
  if (!path || !existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isLiveEntry);
  } catch {
    return [];
  }
}

class DaemonChildProcessRegistry {
  private path: string | undefined;
  private readonly live = new Map<number, LiveDaemonChildProcessEntry>();
  private exitHookRegistered = false;
  private supervisorStarted = false;

  configure(path: string, options: DaemonChildProcessRegistryConfigureOptions = {}): number {
    this.path = path;
    this.registerExitHook();
    this.startCrashSupervisor(path, options.supervisorEntryPath);
    const orphaned = this.readPersisted();
    for (const entry of orphaned) killDaemonProcessTree(entry.pid);
    this.persist();
    return orphaned.length;
  }

  track(pid: number | undefined, label: string, kill?: () => void): void {
    if (pid === undefined || pid <= 0) return;
    this.registerExitHook();
    this.live.set(pid, { pid, label, kill });
    this.persist();
  }

  untrack(pid: number | undefined): void {
    if (pid === undefined || pid <= 0) return;
    this.live.delete(pid);
    this.persist();
  }

  killAll(): void {
    for (const entry of this.live.values()) {
      try {
        entry.kill?.();
      } catch {
        killDaemonProcessTree(entry.pid);
        continue;
      }
      if (!entry.kill) killDaemonProcessTree(entry.pid);
    }
    this.live.clear();
    this.persist();
  }

  private registerExitHook(): void {
    if (this.exitHookRegistered) return;
    this.exitHookRegistered = true;
    process.on('exit', () => this.killAll());
  }

  private readPersisted(): DaemonChildProcessEntry[] {
    return readPersistedEntries(this.path);
  }

  private persist(): void {
    if (!this.path) return;
    if (this.live.size === 0) {
      try {
        unlinkSync(this.path);
      } catch {
        /* already absent */
      }
      return;
    }
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify([...this.live.values()].map(({ pid, label }) => ({ pid, label }))));
  }

  private startCrashSupervisor(path: string, entryPath?: string, deps: StartCrashSupervisorDeps = {}): void {
    if (this.supervisorStarted || isDaemonChildSupervisorInvocation()) return;
    this.supervisorStarted = true;
    const supervisorArgv = daemonChildSupervisorArgv({ entryPath, parentPid: process.pid, registryPath: path });
    const proc = (deps.spawn ?? Bun.spawn)(daemonChildSupervisorLauncherArgv(supervisorArgv, deps.platform), {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      detached: true
    });
    proc.unref();
  }
}

export const daemonChildProcesses = new DaemonChildProcessRegistry();
