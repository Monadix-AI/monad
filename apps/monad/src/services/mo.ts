import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { daemonChildProcesses, killDaemonProcessTree } from '@/infra/daemon-child-processes.ts';

export class MoService {
  private proc: ReturnType<typeof Bun.spawn> | null = null;

  // socketPath is the daemon's own unix socket; it's passed to Mo via MO_DAEMON_SOCK so the
  // sprite talks to *this* daemon instance and refuses to run unless launched by the daemon.
  // tcpPort is the daemon's TCP port; Mo connects a WebSocket to ws://127.0.0.1:{port}/stream
  // for health signalling and session event delivery (replacing the legacy HTTP health poll + SSE).
  constructor(
    private readonly binaryPath: string | undefined,
    private readonly socketPath: string,
    private readonly tcpPort: number
  ) {}

  // Resolve the Mo binary. config.json `mo.binaryPath` overrides this. In a release build it sits next to bin/monad
  // (the bin/monad-sandbox-launcher convention). In dev (`bun src/main.ts`) execPath is the Bun
  // runtime, so we also probe the repo's built Mo.app (derived from the source entrypoint) — that
  // way `bun dev` finds it once apps/mo is built (postinstall builds it on macOS). Returns the first
  // existing candidate, or the primary path so the not-found error names a sensible location.
  static bundledPath(): string {
    const rel = process.platform === 'darwin' ? join('Mo.app', 'Contents', 'MacOS', 'mo') : 'monad-mo';
    const primary = join(dirname(process.execPath), rel);
    const candidates = [primary];
    const entry = process.argv[1] ?? '';
    const marker = join('apps', 'monad', 'src', 'main.ts');
    if (entry.endsWith(marker)) {
      const repo = entry.slice(0, entry.length - marker.length);
      candidates.push(join(repo, 'apps', 'mo', 'native', 'macos', 'Mo.app', 'Contents', 'MacOS', 'mo'));
    }
    return candidates.find((p) => existsSync(p)) ?? primary;
  }

  // Pidfile next to the daemon socket. Mo is keyed to the socket path (MO_DAEMON_SOCK), which is
  // stable across daemon restarts, so a Mo that outlived a crashed daemon reconnects to the new one.
  // The pidfile lets the new daemon re-adopt that process (status + quit) instead of spawning a
  // duplicate — process.on('exit') can't clean up after a SIGKILL/crash.
  private pidFile(): string {
    return join(dirname(this.socketPath), 'mo.pid');
  }

  private static alive(pid: number): boolean {
    try {
      process.kill(pid, 0); // signal 0 = liveness probe (no signal sent)
      return true;
    } catch {
      return false;
    }
  }

  // The live Mo pid for this daemon: our own child if running, else a re-adopted one from the pidfile.
  private trackedPid(): number | null {
    if (this.proc?.pid != null && this.proc.exitCode == null) return this.proc.pid;
    try {
      const pid = Number.parseInt(readFileSync(this.pidFile(), 'utf8').trim(), 10);
      return Number.isInteger(pid) && MoService.alive(pid) ? pid : null;
    } catch {
      return null;
    }
  }

  isRunning(): boolean {
    return this.trackedPid() != null;
  }

  async launch(): Promise<{ ok: boolean; error?: string }> {
    if (!this.binaryPath) return { ok: false, error: 'Mo binary not configured' };
    if (!existsSync(this.binaryPath)) return { ok: false, error: `Mo binary not found at ${this.binaryPath}` };
    if (this.isRunning()) return { ok: true }; // already running (this run, or re-adopted from a prior one)
    try {
      this.proc = Bun.spawn([this.binaryPath], {
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: true,
        env: { ...process.env, MO_DAEMON_SOCK: this.socketPath, MO_DAEMON_PORT: String(this.tcpPort) }
      });
      const pid = this.proc.pid;
      daemonChildProcesses.track(pid, 'mo', () => killDaemonProcessTree(pid));
      void this.proc.exited.then(() => daemonChildProcesses.untrack(pid));
      try {
        writeFileSync(this.pidFile(), String(this.proc.pid));
      } catch {
        /* best-effort — a missing pidfile only loses cross-restart re-adoption */
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  quit(): void {
    const pid = this.trackedPid(); // capture before clearing the handle (covers re-adopted orphans)
    if (this.proc?.pid) killDaemonProcessTree(this.proc.pid);
    daemonChildProcesses.untrack(this.proc?.pid);
    this.proc = null;
    if (pid != null) {
      try {
        process.kill(pid);
      } catch {
        /* already gone */
      }
    }
    try {
      unlinkSync(this.pidFile());
    } catch {
      /* no pidfile */
    }
  }

  // Called on process.on('exit') — synchronous, no await.
  stop(): void {
    this.quit();
  }
}
