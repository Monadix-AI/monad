import type { Logger } from '@monad/logger';

import { killDaemonProcessTree } from '#/infra/daemon-child-processes.ts';

// Process lifecycle supervision only. This layer does not sandbox, does not decide approvals, and
// never captures env/stdout/stderr. Callers compose it with sandboxedSpawn, daemonChildProcesses, or
// domain-specific kill functions when they need those policies.

type SpawnOptions<
  In extends Bun.SpawnOptions.Writable,
  Out extends Bun.SpawnOptions.Readable,
  Err extends Bun.SpawnOptions.Readable
> = Bun.SpawnOptions.SpawnOptions<In, Out, Err> | undefined;

const DEFAULT_KILL_AFTER_MS = 2_000;

type SpawnExitReason = 'exit' | 'timeout' | 'abort' | 'manual' | 'shutdown' | 'spawn_error' | 'exit_wait_error';

type SpawnStopReason = 'manual' | 'shutdown';

export interface SpawnLifecycleEvent {
  phase:
    | 'start'
    | 'pid'
    | 'tracked'
    | 'untracked'
    | 'timeout'
    | 'timeout_escalated'
    | 'timeout_kill_error'
    | 'abort'
    | 'abort_kill_error'
    | 'stop'
    | 'stop_kill_error'
    | 'exit'
    | 'exit_error'
    | 'spawn_error';
  event: string;
  pid?: number;
  exitReason?: SpawnExitReason;
  exitCode?: number | null;
  durationMs?: number;
  err?: unknown;
}

interface SpawnResult {
  exitReason: SpawnExitReason;
  exitCode: number | null;
  durationMs: number;
  err?: unknown;
}

export interface SpawnSupervision {
  tracked: Promise<void>;
  result: Promise<SpawnResult>;
  timeoutElapsed?: Promise<void>;
  clearTimeout(): void;
  untrack(): Promise<void>;
  stop(reason?: SpawnStopReason, signal?: NodeJS.Signals): void;
}

export type SupervisedSubprocess<
  In extends Bun.SpawnOptions.Writable,
  Out extends Bun.SpawnOptions.Readable,
  Err extends Bun.SpawnOptions.Readable
> = Bun.Subprocess<In, Out, Err> & { supervision: SpawnSupervision };

export interface SpawnProcessTracker {
  track(pid: number, label: string, kill: () => void): void | Promise<void>;
  untrack(pid: number): void | Promise<void>;
}

export interface TimeoutOptions {
  ms: number;
  signal?: NodeJS.Signals;
  killAfterMs?: number;
  killSignal?: NodeJS.Signals;
}

export function timeoutWithEscalation(
  ms: number,
  signal: NodeJS.Signals = 'SIGTERM',
  killAfterMs = DEFAULT_KILL_AFTER_MS,
  killSignal: NodeJS.Signals = 'SIGKILL'
): TimeoutOptions {
  return { ms, signal, killAfterMs, killSignal };
}

export function daemonTrackedSpawnOptions<
  In extends Bun.SpawnOptions.Writable,
  Out extends Bun.SpawnOptions.Readable,
  Err extends Bun.SpawnOptions.Readable
>(opts: {
  event: string;
  log: Logger;
  tracker: SpawnProcessTracker;
  trackLabel: string;
  context?: Record<string, unknown>;
  kill?: (proc: Bun.Subprocess<In, Out, Err>, signal: NodeJS.Signals) => void;
  timeout?: TimeoutOptions;
  abortSignal?: AbortSignal;
  abortKillSignal?: NodeJS.Signals;
  onLifecycle?: (event: SpawnLifecycleEvent) => void;
}): Pick<
  SupervisedSpawnOptions<In, Out, Err>,
  | 'event'
  | 'log'
  | 'tracker'
  | 'trackLabel'
  | 'context'
  | 'kill'
  | 'timeout'
  | 'abortSignal'
  | 'abortKillSignal'
  | 'onLifecycle'
> {
  return opts;
}

export function daemonTrackedProcessTreeSpawnOptions<
  In extends Bun.SpawnOptions.Writable,
  Out extends Bun.SpawnOptions.Readable,
  Err extends Bun.SpawnOptions.Readable
>(opts: Omit<Parameters<typeof daemonTrackedSpawnOptions<In, Out, Err>>[0], 'kill'>) {
  return daemonTrackedSpawnOptions<In, Out, Err>({
    ...opts,
    kill: (proc) => killDaemonProcessTree(proc.pid)
  });
}

export interface SupervisedSpawnOptions<
  In extends Bun.SpawnOptions.Writable,
  Out extends Bun.SpawnOptions.Readable,
  Err extends Bun.SpawnOptions.Readable
> {
  event: string;
  log: Logger;
  context?: Record<string, unknown>;
  spawn?: (argv: string[], options: SpawnOptions<In, Out, Err>) => Bun.Subprocess<In, Out, Err>;
  timeout?: TimeoutOptions;
  abortSignal?: AbortSignal;
  abortKillSignal?: NodeJS.Signals;
  kill?: (proc: Bun.Subprocess<In, Out, Err>, signal: NodeJS.Signals) => void;
  trackLabel?: string;
  tracker?: SpawnProcessTracker;
  onLifecycle?: (event: SpawnLifecycleEvent) => void;
  successLogLevel?: 'trace' | 'debug';
}

function errorRecord(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  return { message: err.message, stack: err.stack };
}

function cwdRecord(
  options: SpawnOptions<Bun.SpawnOptions.Writable, Bun.SpawnOptions.Readable, Bun.SpawnOptions.Readable>
): string | undefined {
  return options?.cwd === undefined ? undefined : String(options.cwd);
}

function stdioRecord(
  options: SpawnOptions<Bun.SpawnOptions.Writable, Bun.SpawnOptions.Readable, Bun.SpawnOptions.Readable>
): Record<string, unknown> {
  return {
    stdin: options?.stdin,
    stdout: options?.stdout,
    stderr: options?.stderr,
    terminal: Boolean('terminal' in (options ?? {}))
  };
}

export function redactedSpawnArgv(argv: readonly string[]): string[] {
  if (argv.length <= 1) return [...argv];
  return [argv[0] ?? '[unknown]', ...argv.slice(1).map(() => '[redacted]')];
}

export function supervisedSpawn<
  const In extends Bun.SpawnOptions.Writable = 'ignore',
  const Out extends Bun.SpawnOptions.Readable = 'pipe',
  const Err extends Bun.SpawnOptions.Readable = 'inherit'
>(
  argv: string[],
  options: SpawnOptions<In, Out, Err>,
  logging: SupervisedSpawnOptions<In, Out, Err>
): SupervisedSubprocess<In, Out, Err> {
  const spawn =
    logging.spawn ??
    ((spawnArgv: string[], spawnOptions: SpawnOptions<In, Out, Err>) => Bun.spawn(spawnArgv, spawnOptions));
  const startedAt = Date.now();
  const base = {
    ...(logging.context ?? {}),
    argv: redactedSpawnArgv(argv),
    cwd: cwdRecord(options),
    stdio: stdioRecord(options),
    detached: options?.detached
  };
  const emit = (event: SpawnLifecycleEvent): void => logging.onLifecycle?.(event);
  const successLogLevel = logging.successLogLevel ?? 'debug';

  logging.log[successLogLevel]({ ...base, event: `${logging.event}.start` }, 'process spawn');
  emit({ phase: 'start', event: `${logging.event}.start` });

  try {
    const proc = spawn(argv, options);
    const timeout = logging.timeout;
    const tracker = logging.tracker;

    let timeoutTimer: Timer | undefined;
    let escalationTimer: Timer | undefined;
    let tracked = false;
    let untrackRequested = false;
    let untracking: Promise<void> | undefined;
    let terminationReason: SpawnExitReason | undefined;
    let resolveTimeoutElapsed: (() => void) | undefined;
    let abortListener: (() => void) | undefined;
    let resolveResult!: (result: SpawnResult) => void;
    const result = new Promise<SpawnResult>((resolve) => {
      resolveResult = resolve;
    });
    const killProcess = (signal: NodeJS.Signals): void =>
      (logging.kill ?? ((child, killSignal) => child.kill(killSignal)))(proc, signal);

    const supervision: SpawnSupervision = {
      tracked: Promise.resolve(),
      result,
      clearTimeout: () => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (escalationTimer) clearTimeout(escalationTimer);
        timeoutTimer = undefined;
        escalationTimer = undefined;
      },
      untrack: async () => {
        if (!tracker) return;
        if (untracking) {
          await untracking;
          return;
        }
        if (!tracked) {
          untrackRequested = true;
          return;
        }
        tracked = false;
        untrackRequested = false;
        untracking = Promise.resolve(tracker.untrack(proc.pid))
          .then(() => {
            emit({ phase: 'untracked', event: `${logging.event}.untracked`, pid: proc.pid });
          })
          .finally(() => {
            untracking = undefined;
          });
        await untracking;
      },
      stop: (reason = 'manual', signal = 'SIGTERM') => {
        terminate(reason, signal);
      }
    };

    const terminate = (reason: 'timeout' | 'abort' | SpawnStopReason, signal: NodeJS.Signals): void => {
      const previousReason = terminationReason;
      if (previousReason && previousReason !== reason) return;
      if (previousReason && reason !== 'timeout') return;
      terminationReason ??= reason;
      if (reason !== 'timeout') supervision.clearTimeout();
      try {
        if (reason === 'manual' || reason === 'shutdown') {
          logging.log.warn(
            {
              ...(logging.context ?? {}),
              event: `${logging.event}.stop`,
              exitReason: reason,
              pid: proc.pid,
              signal,
              durationMs: Date.now() - startedAt
            },
            'process stop requested'
          );
          emit({
            phase: 'stop',
            event: `${logging.event}.stop`,
            pid: proc.pid,
            exitReason: reason,
            durationMs: Date.now() - startedAt
          });
        }
        killProcess(signal);
      } catch (err) {
        const phase =
          reason === 'timeout' ? 'timeout_kill_error' : reason === 'abort' ? 'abort_kill_error' : 'stop_kill_error';
        logging.log.warn(
          {
            ...(logging.context ?? {}),
            event: `${logging.event}.${phase}`,
            exitReason: reason,
            pid: proc.pid,
            err: errorRecord(err)
          },
          reason === 'timeout'
            ? 'process timeout kill failed'
            : reason === 'abort'
              ? 'process abort kill failed'
              : 'process stop kill failed'
        );
        emit({ phase, event: `${logging.event}.${phase}`, pid: proc.pid, exitReason: reason, err: errorRecord(err) });
      }
    };

    if (tracker) {
      const trackerSignal = timeout?.signal ?? logging.abortKillSignal ?? 'SIGTERM';
      supervision.tracked = Promise.resolve(
        tracker.track(proc.pid, logging.trackLabel ?? logging.event, () => {
          const reason =
            terminationReason === 'timeout' || terminationReason === 'abort' ? terminationReason : 'shutdown';
          terminate(reason, trackerSignal);
        })
      ).then(() => {
        tracked = true;
        emit({ phase: 'tracked', event: `${logging.event}.tracked`, pid: proc.pid });
        if (untrackRequested) return supervision.untrack();
      });
    }

    if (timeout) {
      const signal = timeout.signal ?? 'SIGTERM';
      supervision.timeoutElapsed = new Promise<void>((resolve) => {
        resolveTimeoutElapsed = resolve;
      });
      timeoutTimer = setTimeout(() => {
        timeoutTimer = undefined;
        logging.log.warn(
          {
            ...(logging.context ?? {}),
            event: `${logging.event}.timeout`,
            exitReason: 'timeout',
            pid: proc.pid,
            timeoutMs: timeout.ms,
            signal,
            durationMs: Date.now() - startedAt
          },
          'process timed out'
        );
        emit({
          phase: 'timeout',
          event: `${logging.event}.timeout`,
          pid: proc.pid,
          exitReason: 'timeout',
          durationMs: Date.now() - startedAt
        });
        terminate('timeout', signal);
        resolveTimeoutElapsed?.();
        if (timeout.killAfterMs !== undefined) {
          const killSignal = timeout.killSignal ?? 'SIGKILL';
          escalationTimer = setTimeout(() => {
            escalationTimer = undefined;
            logging.log.warn(
              {
                ...(logging.context ?? {}),
                event: `${logging.event}.timeout_escalated`,
                exitReason: 'timeout',
                pid: proc.pid,
                signal: killSignal,
                durationMs: Date.now() - startedAt
              },
              'process timeout escalation'
            );
            emit({
              phase: 'timeout_escalated',
              event: `${logging.event}.timeout_escalated`,
              pid: proc.pid,
              exitReason: 'timeout',
              durationMs: Date.now() - startedAt
            });
            terminate('timeout', killSignal);
          }, timeout.killAfterMs);
        }
      }, timeout.ms);
    }

    if (logging.abortSignal) {
      abortListener = () => {
        const signal = logging.abortKillSignal ?? 'SIGTERM';
        logging.log.warn(
          {
            ...(logging.context ?? {}),
            event: `${logging.event}.abort`,
            exitReason: 'abort',
            pid: proc.pid,
            signal,
            durationMs: Date.now() - startedAt
          },
          'process aborted'
        );
        emit({
          phase: 'abort',
          event: `${logging.event}.abort`,
          pid: proc.pid,
          exitReason: 'abort',
          durationMs: Date.now() - startedAt
        });
        terminate('abort', signal);
      };
      if (logging.abortSignal.aborted) abortListener();
      else logging.abortSignal.addEventListener('abort', abortListener, { once: true });
    }

    const supervised = Object.assign(proc, { supervision });
    logging.log[successLogLevel](
      { ...(logging.context ?? {}), event: `${logging.event}.pid`, pid: proc.pid },
      'process spawned'
    );
    emit({ phase: 'pid', event: `${logging.event}.pid`, pid: proc.pid });

    void proc.exited.then(
      async (exitCode) => {
        supervision.clearTimeout();
        if (abortListener) logging.abortSignal?.removeEventListener('abort', abortListener);
        const exitReason = terminationReason ?? 'exit';
        const durationMs = Date.now() - startedAt;
        logging.log[successLogLevel](
          {
            ...(logging.context ?? {}),
            event: `${logging.event}.exit`,
            exitReason,
            pid: proc.pid,
            exitCode,
            durationMs
          },
          'process exited'
        );
        emit({ phase: 'exit', event: `${logging.event}.exit`, pid: proc.pid, exitReason, exitCode, durationMs });
        await supervision.untrack();
        resolveResult({ exitReason, exitCode, durationMs });
      },
      async (err) => {
        supervision.clearTimeout();
        if (abortListener) logging.abortSignal?.removeEventListener('abort', abortListener);
        const exitReason = terminationReason ?? 'exit_wait_error';
        const durationMs = Date.now() - startedAt;
        const recorded = errorRecord(err);
        logging.log.warn(
          {
            ...(logging.context ?? {}),
            event: `${logging.event}.exit_error`,
            exitReason,
            pid: proc.pid,
            err: recorded,
            durationMs
          },
          'process exit wait failed'
        );
        emit({
          phase: 'exit_error',
          event: `${logging.event}.exit_error`,
          pid: proc.pid,
          exitReason,
          err: recorded,
          durationMs
        });
        await supervision.untrack();
        resolveResult({ exitReason, exitCode: null, durationMs, err: recorded });
      }
    );
    return supervised;
  } catch (err) {
    const recorded = errorRecord(err);
    logging.log.error(
      { ...base, event: `${logging.event}.error`, exitReason: 'spawn_error', err: recorded },
      'process spawn failed'
    );
    emit({ phase: 'spawn_error', event: `${logging.event}.error`, exitReason: 'spawn_error', err: recorded });
    throw err;
  }
}
