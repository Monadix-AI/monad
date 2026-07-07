import { closeSync, openSync } from 'node:fs';
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
  if (pid && isAlive(pid) && (await waitForReachable(3000))) {
    out(yellow(t('cli.daemon.alreadyRunning')) + dim(t('cli.daemon.pid', { pid })));
    return { alreadyRunning: true };
  }

  // The daemon owns the startup banner + ready-info (single source of truth for `monad start`,
  // `monad daemon`, and the installer). Launch it detached: its banner/ready-info go to stdout —
  // which we pipe and relay to the user until it's reachable — while its logs go to stderr → the
  // persistent daemon.log. The daemon writes nothing more to stdout after startup, so closing the
  // pipe when we exit can't EPIPE it. --start-relay tells it to emit the banner and route logs.
  const logPath = join(getPaths().logs, 'daemon.log');
  await mkdir(getPaths().logs, { recursive: true });
  // Size-cap daemon.log at this start boundary: the CLI's inherited stderr fd (below) pins the file
  // open for the daemon's lifetime, so it can't be rotated mid-run — rotate before opening a fresh one.
  rotateDaemonLog(logPath);
  const logFd = openSync(logPath, 'a');

  // Dev: resolve the daemon source from daemon.ts's own location (apps/cli/src/lib/ → apps/monad/src/).
  // Release: the compiled binary handles all subcommands — spawn self with 'daemon'.
  const devEntry = resolve(import.meta.dir, '../../../monad/src/main.ts');
  const isDevEntry = await Bun.file(devEntry).exists();
  // --start-relay tells the daemon to emit its banner/ready-info to stdout for relay
  // to the user, and to route logs to stderr (daemon.log) so stdout stays clean.
  // Pass --log-file so the daemon writes daemon.log itself (see configureDaemonLogging). The `stderr:
  // logFd` redirect below still captures native/pre-logger crash output on Unix, but a detached child
  // does not inherit that fd on Windows — so the daemon owning the file is what populates it there.
  const relayArgs = ['--start-relay', '--log-file', logPath];
  const argv = isDevEntry ? ['bun', devEntry, ...relayArgs] : [process.execPath, 'daemon', ...relayArgs];
  const proc = Bun.spawn(argv, {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: logFd,
    detached: true
  });
  closeSync(logFd);
  await Bun.write(getPidPath(), String(proc.pid));
  proc.unref();

  await relayUntilReady(proc.stdout, proc.pid, logPath);
  return { alreadyRunning: false };
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
