import { appendFileSync, closeSync, openSync } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { makeLoopbackHttpsFetcher } from '@monad/client';
import { getPaths, loadAll, resolveClientConn } from '@monad/home';
import { rotateDaemonLog } from '@monad/monad/log-maintenance';

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
      // netstat -ano lines: "  TCP  0.0.0.0:52749  0.0.0.0:0  LISTENING  1234"
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

export async function startDaemon(): Promise<{ alreadyRunning: boolean }> {
  // The installer stops any running daemon before overwriting the binary, so a reachable daemon
  // here is an intentional one the caller is reusing — report it and leave it running.
  if (await isDaemonReachable()) {
    const pid = (await readPid()) ?? (await getPortPid());
    out(yellow(t('cli.daemon.alreadyRunning')) + (pid ? dim(t('cli.daemon.pid', { pid })) : ''));
    return { alreadyRunning: true };
  }

  // Validate user-edited config before daemon spawn so startup errors are visible.
  const paths = getPaths();
  try {
    await loadAll(paths.config, paths.profile);
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
    out(yellow(t('cli.daemon.alreadyRunning')) + dim(t('cli.daemon.pid', { pid })));
    return { alreadyRunning: true };
  }

  // The daemon owns the startup banner + ready-info in dev. In release it is supervised, so startup
  // readiness is detected by /health instead of stdout relay; otherwise the supervisor would keep a
  // pipe tied to this short-lived CLI process.
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
  if (!isDevEntry && process.platform !== 'win32') {
    closeSync(logFd);
    const result = Bun.spawnSync(
      [
        'sh',
        '-c',
        'nohup "$1" daemon-supervisor "$2" </dev/null >/dev/null 2>>"$2" & printf "%s\\n" "$!"',
        'monad-supervisor-launch',
        process.execPath,
        logPath
      ],
      { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }
    );
    const supervisorPid = Number.parseInt(new TextDecoder().decode(result.stdout).trim(), 10);
    if (result.exitCode !== 0 || !Number.isInteger(supervisorPid) || supervisorPid <= 0) {
      const stderr = new TextDecoder().decode(result.stderr).trim();
      throw new Error(stderr || `failed to launch daemon supervisor (${logPath})`);
    }
    await Bun.write(getPidPath(), String(supervisorPid));
    await waitUntilReady(supervisorPid, logPath);
    return { alreadyRunning: false };
  }

  const releaseSupervisorArgs = [process.execPath, 'daemon-supervisor', logPath];
  const argv = isDevEntry ? ['bun', devEntry, ...relayArgs] : releaseSupervisorArgs;
  const proc = Bun.spawn(argv, {
    stdin: 'ignore',
    stdout: isDevEntry ? 'pipe' : 'ignore',
    stderr: logFd,
    detached: true
  });
  closeSync(logFd);
  await Bun.write(getPidPath(), String(proc.pid));
  proc.unref();

  if (isDevEntry && proc.stdout instanceof ReadableStream) await relayUntilReady(proc.stdout, proc.pid, logPath);
  else await waitUntilReady(proc.pid, logPath);
  return { alreadyRunning: false };
}

type SupervisedProcess = ReturnType<typeof Bun.spawn>;
type SupervisorAction = { type: 'exit'; code: number } | { type: 'restart' };

export function nextDaemonSupervisorAction(args: {
  started: boolean;
  readyOnce: boolean;
  exitCode: number | null | undefined;
}): SupervisorAction {
  if (!args.started && !args.readyOnce) return { type: 'exit', code: args.exitCode ?? 1 };
  if ((args.exitCode ?? 0) === 0) return { type: 'exit', code: 0 };
  return { type: 'restart' };
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
    child = Bun.spawn([process.execPath, 'daemon', '--start-relay', '--log-file', logPath], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: logFd,
      env: { ...Bun.env, MONAD_SUPERVISOR_PID: String(process.pid) }
    });
    closeSync(logFd);
    supervisorLog(logPath, 'daemon supervisor started child', { childPid: child.pid }, 30);

    const started = await waitForSupervisorReady(child);
    const exitCode = await child.exited.catch(() => 1);
    if (stopping) return;
    const action = nextDaemonSupervisorAction({ started, readyOnce, exitCode });
    if (action.type === 'exit') {
      await clearSupervisorPidFile();
      process.exit(action.code);
    }

    readyOnce = readyOnce || started;
    supervisorLog(logPath, 'daemon exited unexpectedly — restarting', {
      childPid: child.pid,
      exitCode,
      restartInMs: backoffMs
    });
    await Bun.sleep(backoffMs);
    backoffMs = Math.min(backoffMs * 2, 5000);
  }
}

async function waitUntilReady(pid: number, logPath: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) break;
    if (await isDaemonReachable()) return;
    await Bun.sleep(150);
  }
  out(yellow(t('cli.daemon.notReady')) + dim(` (${logPath})`));
}

/** Relay the detached daemon's stdout (its banner + ready-info) to the user until the daemon is
 *  reachable, then stop — leaving it running in the background. */
async function relayUntilReady(stream: ReadableStream<Uint8Array>, pid: number, logPath: string): Promise<void> {
  const reader = stream.getReader();
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value?.length) process.stdout.write(value);
      }
    } catch {
      /* reader cancelled once we're ready — expected */
    }
  })();

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
  if (ready) await Bun.sleep(600);
  else if (isAlive(pid)) out(yellow(t('cli.daemon.notReady')) + dim(` (${logPath})`));

  await reader.cancel().catch(() => {});
  await pump;
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

export async function stopDaemon(): Promise<void> {
  let pid = await readPid();
  if (!pid || !isAlive(pid)) pid = await getPortPid();
  if (!pid || !isAlive(pid)) {
    out(yellow(t('cli.daemon.notRunning')));
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
  printGoodbye();
  out(green(t('cli.daemon.stopped')) + dim(t('cli.daemon.pid', { pid })));

  // Wait for the process to actually exit before returning so callers that open the DB or
  // rewrite config files don't race against the daemon's in-flight shutdown writes.
  const deadline = Date.now() + 3000;
  while (isAlive(pid) && Date.now() < deadline) {
    await Bun.sleep(50);
  }
}
