import { appendFileSync, closeSync, openSync } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { makeLoopbackHttpsFetcher } from '@monad/client';
import { getPaths, loadAll, resolveClientConn, roleExecPath } from '@monad/environment';
import { rotateDaemonLog } from '@monad/monad/log-maintenance';
import { DAEMON_RESTART_EXIT_CODE } from '@monad/protocol';

import { t } from './i18n.ts';
import { bold, cyan, dim, green, out, printGoodbye, red, yellow } from './output.ts';

function getPidPath(): string {
  return getPaths().pid;
}

async function readPid(): Promise<number | null> {
  try {
    const text = await Bun.file(getPidPath()).text();
    const pid = parseInt(text.trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isSourceCliInvocation(): boolean {
  return process.argv.some((arg) => arg.endsWith('/apps/cli/src/bin.ts') || arg.endsWith('/apps/cli/src/main.ts'));
}

async function isDaemonReachable(): Promise<boolean> {
  const { baseUrl } = await resolveClientConn();
  const fetcher = makeLoopbackHttpsFetcher(baseUrl) ?? fetch;
  try {
    const res = await fetcher(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Poll /health until the daemon answers or the deadline passes. Lets a process that already holds
 *  the PID file (but isn't serving yet) finish binding before we treat its PID as stale. */
async function waitForReachable(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isDaemonReachable()) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(150);
  }
}

/** Best-effort: get the PID of the process listening on the daemon port. */
async function getPortPid(): Promise<number | null> {
  const { baseUrl } = await resolveClientConn();
  const port = new URL(baseUrl).port;
  try {
    if (process.platform === 'win32') {
      // netstat -ano lines: "  TCP  0.0.0.0:47749  0.0.0.0:0  LISTENING  1234"
      const result = Bun.spawnSync(['netstat', '-ano', '-p', 'TCP'], { stderr: 'ignore' });
      if (result.exitCode !== 0) return null;
      for (const line of new TextDecoder().decode(result.stdout).split('\n')) {
        const m = line.match(/TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
        if (m?.[1] === port) return parseInt(m[2] ?? '', 10);
      }
      return null;
    }
    const result = Bun.spawnSync(['lsof', '-ti', `:${port}`], { stderr: 'ignore' });
    if (result.exitCode !== 0) return null;
    const pid = parseInt(new TextDecoder().decode(result.stdout).trim().split('\n')[0] ?? '', 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function releaseDaemonSupervisorSpawnOptions(execPath: string, logPath: string) {
  return {
    argv: [roleExecPath(execPath, 'restart'), 'daemon-supervisor', logPath],
    detached: true as const,
    stdin: 'ignore' as const,
    stdout: 'pipe' as const
  };
}

export function daemonSupervisorChildStdout(readyOnce: boolean): 'pipe' | 'ignore' {
  return readyOnce ? 'ignore' : 'pipe';
}

export interface DaemonLifecycleOptions {
  requireReady?: boolean;
  silent?: boolean;
}

export function resolveDaemonPresentation(options: DaemonLifecycleOptions = {}): {
  relayStartup: boolean;
  reportLifecycle: boolean;
} {
  return options.silent
    ? { relayStartup: false, reportLifecycle: false }
    : { relayStartup: true, reportLifecycle: true };
}

export async function startDaemon(options: DaemonLifecycleOptions = {}): Promise<{ alreadyRunning: boolean }> {
  const presentation = resolveDaemonPresentation(options);
  // The installer stops any running daemon before overwriting the binary, so a reachable daemon
  // here is an intentional one the caller is reusing — report it and leave it running.
  if (await isDaemonReachable()) {
    const pid = (await readPid()) ?? (await getPortPid());
    if (presentation.reportLifecycle) {
      out(yellow(t('cli.daemon.alreadyRunning')) + (pid ? dim(t('cli.daemon.pid', { pid })) : ''));
    }
    return { alreadyRunning: true };
  }

  // Validate user-edited config before daemon spawn so startup errors are visible.
  const paths = getPaths();
  try {
    await loadAll(paths);
  } catch (err) {
    throw new Error(formatConfigValidationError(paths.config, err));
  }

  const pid = await readPid();
  // A process with the recorded PID is alive, but /health didn't answer above. It may be a daemon
  // still binding its socket (e.g. one started by `bun dev`) — give it a brief grace period. If it
  // never becomes reachable the PID is stale (a crashed daemon whose PID was recycled, or a hung
  // process), so we fall through and (re)start; the daemon's singleton lock guards a true double-run.
  // Reachability — the same signal `monad status` uses — is the source of truth, never bare liveness.
  if (pid && isAlive(pid) && (await waitForReachable(8000))) {
    if (presentation.reportLifecycle) {
      out(yellow(t('cli.daemon.alreadyRunning')) + dim(t('cli.daemon.pid', { pid })));
    }
    return { alreadyRunning: true };
  }

  // The daemon owns the startup banner + ready-info. Dev relays it directly; release relays the
  // supervisor's first child only, then disconnects once /health is ready so the background
  // supervisor is not tied to this short-lived CLI process.
  const logPath = join(getPaths().logs, 'daemon.log');
  await mkdir(getPaths().logs, { recursive: true });
  // Size-cap daemon.log at this start boundary: the CLI's inherited stderr fd (below) pins the file
  // open for the daemon's lifetime, so it can't be rotated mid-run — rotate before opening a fresh one.
  rotateDaemonLog(logPath);
  const logFd = openSync(logPath, 'a');

  // Dev: resolve the daemon source from daemon.ts's own location (apps/cli/src/lib/ → apps/monad/src/).
  // Release: the compiled binary handles all subcommands — spawn self with 'daemon'.
  const devEntry = resolve(import.meta.dir, '../../../monad/src/main.ts');
  const isDevEntry = isSourceCliInvocation() && (await Bun.file(devEntry).exists());
  // --start-relay tells the daemon to emit its banner/ready-info to stdout for relay
  // to the user, and to route logs to stderr (daemon.log) so stdout stays clean.
  // Pass --log-file so the daemon writes daemon.log itself (see configureDaemonLogging). The `stderr:
  // logFd` redirect below still captures native/pre-logger crash output on Unix, but a detached child
  // does not inherit that fd on Windows — so the daemon owning the file is what populates it there.
  const relayArgs = ['--start-relay', '--log-file', logPath];
  const releaseSpawn = releaseDaemonSupervisorSpawnOptions(process.execPath, logPath);
  const spawn = isDevEntry
    ? {
        argv: ['bun', devEntry, ...relayArgs],
        detached: true as const,
        stdin: 'ignore' as const,
        stdout: 'pipe' as const
      }
    : releaseSpawn;
  const proc = Bun.spawn(spawn.argv, {
    stdin: spawn.stdin,
    stdout: spawn.stdout,
    stderr: logFd,
    detached: spawn.detached
  });
  closeSync(logFd);
  await Bun.write(getPidPath(), String(proc.pid));
  proc.unref();

  const ready =
    proc.stdout instanceof ReadableStream
      ? await relayUntilReady(proc.stdout, proc.pid, logPath, presentation)
      : await waitUntilReady(proc.pid, logPath, presentation.reportLifecycle);
  if (!ready && options.requireReady) throw new Error(`${t('cli.daemon.notReady')} (${logPath})`);
  return { alreadyRunning: false };
}

type SupervisedProcess = ReturnType<typeof Bun.spawn>;
type SupervisorAction = { type: 'exit'; code: number } | { type: 'restart'; requested: boolean };

export function nextDaemonSupervisorAction(args: {
  started: boolean;
  readyOnce: boolean;
  exitCode: number | null | undefined;
}): SupervisorAction {
  if (!args.started && !args.readyOnce) return { type: 'exit', code: args.exitCode ?? 1 };
  if ((args.exitCode ?? 0) === 0) return { type: 'exit', code: 0 };
  return { type: 'restart', requested: args.exitCode === DAEMON_RESTART_EXIT_CODE };
}

function supervisorLog(logPath: string, message: string, record: Record<string, unknown> = {}, level = 40): void {
  appendFileSync(
    logPath,
    `${JSON.stringify({
      level,
      time: Date.now(),
      pid: process.pid,
      name: 'monad-supervisor',
      ...record,
      msg: message
    })}\n`
  );
}

async function terminateSupervisedChild(child: SupervisedProcess | null): Promise<void> {
  if (!child) return;
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  await Promise.race([child.exited.catch(() => undefined), Bun.sleep(3000)]);
  try {
    process.kill(child.pid, 0);
    child.kill('SIGKILL');
  } catch {}
}

async function clearSupervisorPidFile(): Promise<void> {
  if ((await readPid()) === process.pid) await unlink(getPidPath()).catch(() => {});
}

async function waitForSupervisorReady(child: SupervisedProcess): Promise<boolean> {
  while (true) {
    if (await isDaemonReachable()) return true;
    const exited = await Promise.race([
      child.exited.then(() => true).catch(() => true),
      Bun.sleep(150).then(() => false)
    ]);
    if (exited) return false;
  }
}

export async function runDaemonSupervisor(): Promise<void> {
  const logPath = process.argv[3];
  if (!logPath) throw new Error('daemon-supervisor requires a log file path');

  let child: SupervisedProcess | null = null;
  let stopping = false;
  let readyOnce = false;
  let backoffMs = 500;

  const stop = (signal: NodeJS.Signals) => {
    stopping = true;
    supervisorLog(logPath, 'daemon supervisor stopping', { signal }, 30);
    void terminateSupervisedChild(child).finally(() => {
      void clearSupervisorPidFile().finally(() => process.exit(0));
    });
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
  process.on('SIGHUP', () => supervisorLog(logPath, 'daemon supervisor ignored SIGHUP', {}, 30));

  while (!stopping) {
    const logFd = openSync(logPath, 'a');
    child = Bun.spawn([roleExecPath(process.execPath, 'daemon'), 'daemon', '--start-relay', '--log-file', logPath], {
      stdin: 'ignore',
      stdout: daemonSupervisorChildStdout(readyOnce),
      stderr: logFd,
      env: { ...Bun.env, MONAD_SUPERVISOR_PID: String(process.pid) }
    });
    closeSync(logFd);
    const startupOutput = child.stdout instanceof ReadableStream ? forwardStartupOutput(child.stdout) : null;
    supervisorLog(logPath, 'daemon supervisor started child', { childPid: child.pid }, 30);

    const started = await waitForSupervisorReady(child);
    if (started && startupOutput) await Bun.sleep(600);
    await startupOutput?.stop();
    const exitCode = await child.exited.catch(() => 1);
    if (stopping) return;
    const action = nextDaemonSupervisorAction({ started, readyOnce, exitCode });
    if (action.type === 'exit') {
      await clearSupervisorPidFile();
      process.exit(action.code);
    }

    readyOnce = readyOnce || started;
    const restartInMs = action.requested ? 500 : backoffMs;
    supervisorLog(logPath, action.requested ? 'daemon restart requested' : 'daemon exited unexpectedly — restarting', {
      childPid: child.pid,
      exitCode,
      restartInMs
    });
    await Bun.sleep(restartInMs);
    if (!action.requested) backoffMs = Math.min(backoffMs * 2, 5000);
  }
}

function forwardStartupOutput(stream: ReadableStream<Uint8Array>): { stop: () => Promise<void> } {
  const abort = new AbortController();
  const pump = relayDaemonOutput(stream, true, undefined, abort.signal);
  return {
    stop: async () => {
      abort.abort();
      await pump;
    }
  };
}

async function waitUntilReady(pid: number, logPath: string, reportLifecycle: boolean): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) break;
    if (await isDaemonReachable()) return true;
    await Bun.sleep(150);
  }
  if (reportLifecycle) out(yellow(t('cli.daemon.notReady')) + dim(` (${logPath})`));
  return false;
}

export async function relayDaemonOutput(
  stream: ReadableStream<Uint8Array>,
  forward: boolean,
  write: (value: Uint8Array) => void = (value) => process.stdout.write(value),
  signal?: AbortSignal
): Promise<void> {
  const reader = stream.getReader();
  const abort = () => void reader.cancel();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (forward && value?.length) write(value);
    }
  } catch {
    return;
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

/** Relay the detached daemon's stdout (its banner + ready-info) to the user until the daemon is
 *  reachable, then stop — leaving it running in the background. */
async function relayUntilReady(
  stream: ReadableStream<Uint8Array>,
  pid: number,
  logPath: string,
  presentation: ReturnType<typeof resolveDaemonPresentation>
): Promise<boolean> {
  const relayAbort = new AbortController();
  const pump = relayDaemonOutput(stream, presentation.relayStartup, undefined, relayAbort.signal);

  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) break; // crashed during startup — the reason is now in daemon.log
    if (await isDaemonReachable()) {
      ready = true;
      break;
    }
    await Bun.sleep(150);
  }
  // /health answers the instant the socket is bound, which is just before the banner + ready-info
  // are printed — give them a moment to flush through the pipe before we stop relaying.
  if (ready && presentation.relayStartup) await Bun.sleep(600);
  else if (!ready && isAlive(pid) && presentation.reportLifecycle) {
    out(yellow(t('cli.daemon.notReady')) + dim(` (${logPath})`));
  }

  relayAbort.abort();
  await pump;
  return ready;
}

function formatConfigValidationError(configPath: string, err: unknown): string {
  const reason = (err instanceof Error ? err.message : String(err)).trim();
  const lines = reason.split('\n');
  const summary = lines[0] ?? t('cli.daemon.invalidConfig');
  const details = lines.slice(1).join('\n').trim();

  return [
    `${red('✖')} ${bold(t('cli.daemon.startFailed'))}`,
    `${cyan(t('cli.daemon.configFile'))} ${configPath}`,
    `${cyan(t('cli.daemon.reason'))} ${summary}`,
    details ? `${cyan(t('cli.daemon.details'))}\n${details}` : null,
    `${cyan(t('cli.daemon.nextStep'))} ${dim(t('cli.daemon.fixConfig'))}`
  ]
    .filter((section): section is string => section !== null)
    .join('\n\n');
}

export async function stopDaemon(options: Pick<DaemonLifecycleOptions, 'silent'> = {}): Promise<void> {
  const { reportLifecycle } = resolveDaemonPresentation(options);
  let pid = await readPid();
  if (!pid || !isAlive(pid)) pid = await getPortPid();
  if (!pid || !isAlive(pid)) {
    if (reportLifecycle) out(yellow(t('cli.daemon.notRunning')));
    await unlink(getPidPath()).catch(() => {});
    return;
  }

  if (process.platform === 'win32') {
    // Windows: SIGTERM on a detached process is an unconditional hard-kill (the daemon's signal
    // handlers only fire when it owns an attached console). Instead, ask the daemon to shut itself
    // down via HTTP — this runs all process.on('exit') handlers (MCP child cleanup, socket teardown,
    // channel stop). Fall back to a hard-kill if the endpoint doesn't answer within 3 s.
    const { baseUrl } = await resolveClientConn();
    const fetcher = makeLoopbackHttpsFetcher(baseUrl) ?? fetch;
    const graceful = await fetcher(`${baseUrl}/v1/daemon/stop`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000)
    })
      .then((r) => r.ok)
      .catch(() => false);

    if (!graceful || isAlive(pid)) {
      process.kill(pid, 'SIGTERM');
    }
  } else {
    // Unix: SIGTERM → the daemon's handler runs process.exit(0), executing its exit handlers
    // (kills child MCP processes, stops servers).
    process.kill(pid, 'SIGTERM');
  }

  await unlink(getPidPath()).catch(() => {});
  if (reportLifecycle) {
    printGoodbye();
    out(green(t('cli.daemon.stopped')) + dim(t('cli.daemon.pid', { pid })));
  }

  // Wait for the process to actually exit before returning so callers that open the DB or
  // rewrite config files don't race against the daemon's in-flight shutdown writes.
  const deadline = Date.now() + 3000;
  while (isAlive(pid) && Date.now() < deadline) {
    await Bun.sleep(50);
  }
}
