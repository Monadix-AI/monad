// Node/Bun sink: the real pino implementation. Selected by the `#platform-sink` conditional import
// on node/bun/default; a browser bundle resolves `sink.browser.ts` instead and never pulls pino or
// node:* in here. WHERE node logs land on disk is owned by ./log-files.ts (also exposed via the
// `@monad/logger/log-files` subpath for the maintenance layer) so the writer here and the pruner
// there share one naming source.

import type { CustomLogDestination, LogDestination, Logger, LoggerRecord } from './types.ts';

import { appendFileSync, mkdirSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import pino from 'pino';

import { emitDeveloperRecord, hasDeveloperRecordSubscribers } from './developer.ts';
import { getLogFile, getLoggerConfig, getLogLevel, getLogStderr } from './level.ts';
import { debugLogPath, developerLogFileName } from './log-files.ts';

type PinoLevel = pino.Level | 'silent';
type StreamEntry = { level: pino.Level; stream: pino.DestinationStream };

const LEVEL_RANK: Record<PinoLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: 100
};

// Defense-in-depth secret scrub: even though call sites are expected to scrub, redact common
// credential-bearing keys at any depth so a stray `log.info({ headers })` or error object can't
// leak a token into the (temp-dir, debug) log. `*.` wildcards match the key at any nesting level.
const REDACT_PATHS = [
  'authorization',
  'token',
  'apiKey',
  'accessToken',
  'refreshToken',
  'password',
  'secret',
  'cookie',
  '*.authorization',
  '*.token',
  '*.apiKey',
  '*.accessToken',
  '*.refreshToken',
  '*.password',
  '*.secret',
  '*.cookie'
];
const redact = { paths: REDACT_PATHS, censor: '[redacted]' };

let developerLogDir: string | null = null;

const developerStream: pino.DestinationStream = {
  write(line: string) {
    // Nothing consumes the record (no live SSE subscriber, no on-disk dir) — skip the per-record
    // JSON.parse entirely. developerStream is wired at debug level, so this runs on every record.
    if (!developerLogDir && !hasDeveloperRecordSubscribers()) return;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const channelId = typeof record.channelId === 'string' ? record.channelId : undefined;
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId : undefined;
    const id = channelId ?? sessionId;
    if (!id) return;
    emitDeveloperRecord(record);
    if (!developerLogDir) return;
    const file = join(developerLogDir, developerLogFileName(channelId ? 'channel' : 'session', id));
    void appendFile(file, line.endsWith('\n') ? line : `${line}\n`, 'utf8').catch(() => {});
  }
};

export function setDeveloperLogTransport(opts: { enabled: boolean; dir: string }): void {
  developerLogDir = opts.enabled ? opts.dir : null;
  if (developerLogDir) mkdirSync(developerLogDir, { recursive: true });
}

// Production primary sink: resolve the destination on EVERY write instead of snapshotting it when the
// logger is built. A logger can be materialised before the daemon entrypoint calls setLogFile() /
// setLogStderr() — some module logs during import — and a build-time snapshot would then be wrong for
// the process's whole life (this left daemon.log empty on Windows). Per-write resolution is correct
// regardless of timing; appendFileSync also sidesteps sonic-boom, which silently drops writes inside a
// `bun build --compile` binary, and survives a hard kill of the detached daemon (no buffered tail).
let ensuredLogDir: string | undefined;
const primaryProductionStream: pino.DestinationStream = {
  write(line: string) {
    const file = getLogFile();
    if (file) {
      // Logging is best-effort: a full disk / read-only dir / perms change must not turn a log line
      // into a synchronous throw at an arbitrary call site (or crash the daemon). Fall back to stderr.
      try {
        if (ensuredLogDir !== file) {
          mkdirSync(dirname(file), { recursive: true });
          ensuredLogDir = file;
        }
        appendFileSync(file, line);
      } catch {
        process.stderr.write(line);
      }
      return;
    }
    (getLogStderr() ? process.stderr : process.stdout).write(line);
  }
};

// Build the concrete pino logger. Called LAZILY (see createLogger) so it reads the destination flags
// — getLogStderr()/getLogFile() — at first USE, after the daemon entrypoint has set them, rather than
// at import time when many module-level `const log = createLogger(...)` run before configuration.
function buildLogger(name?: string, context?: Record<string, unknown>): Logger {
  const bindings = { ...(name ? { name } : {}), ...context };
  const LOG_LEVEL_OVERRIDE = getLogLevel() as PinoLevel | undefined;
  const configuredDestinations = getLoggerConfig()?.destinations;

  if (configuredDestinations && configuredDestinations.length > 0) {
    return buildConfiguredLogger(bindings, configuredDestinations, LOG_LEVEL_OVERRIDE);
  }

  // stderr=2 when stdout is a protocol channel (stdio/ACP), else stdout=1.
  const dest = getLogStderr() ? 2 : 1;

  if (Bun.env.NODE_ENV !== 'production') {
    const devTransport: pino.TransportSingleOptions = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        destination: dest,
        translateTime: 'SYS:HH:MM:ss',
        ignore: 'pid,hostname,name,method,path,status,durationMs,transport,transportCall',
        messageFormat: '{if name}\x1B[2m[{name}]\x1B[0m {end}{msg}',
        errorLikeObjectKeys: ['err', 'error'],
        levelFirst: false,
        singleLine: false
      }
    };
    const level: PinoLevel = LOG_LEVEL_OVERRIDE ?? (Bun.env.NODE_ENV === 'test' ? 'silent' : 'debug');
    if (Bun.env.NODE_ENV === 'test' && level !== 'silent') {
      const base = pino(
        { level, redact },
        pino.multistream(
          [
            { level: level as pino.Level, stream: pino.destination({ dest, sync: true }) },
            { level: 'debug' as pino.Level, stream: developerStream }
          ],
          { dedupe: false }
        )
      );
      return asLogger(Object.keys(bindings).length > 0 ? base.child(bindings) : base);
    }
    const pretty = level === 'silent' ? undefined : pino.transport(devTransport);
    const base =
      pretty === undefined
        ? pino({ level, redact })
        : pino(
            { level, redact },
            pino.multistream(
              [
                { level: level === 'silent' ? 'silent' : (level as pino.Level), stream: pretty },
                { level: 'debug' as pino.Level, stream: developerStream }
              ],
              { dedupe: false }
            )
          );
    return asLogger(Object.keys(bindings).length > 0 ? base.child(bindings) : base);
  }

  // Production: info+ → stdout (NDJSON) / stderr / a log file (resolved per-write), debug+ → temp file
  const effectiveLevel: PinoLevel = LOG_LEVEL_OVERRIDE ?? 'info';
  const streams = pino.multistream(
    [
      {
        level: effectiveLevel === 'silent' ? 'silent' : ('info' as pino.Level),
        stream: primaryProductionStream
      },
      {
        level: 'debug' as pino.Level,
        stream: pino.destination({ dest: debugLogPath, sync: false, append: true })
      },
      {
        level: 'debug' as pino.Level,
        stream: developerStream
      }
    ],
    { dedupe: true }
  );

  const base = pino({ level: effectiveLevel === 'silent' ? 'silent' : 'debug', redact }, streams);
  return asLogger(Object.keys(bindings).length > 0 ? base.child(bindings) : base);
}

function buildConfiguredLogger(
  bindings: Record<string, unknown>,
  destinations: readonly LogDestination[],
  override: PinoLevel | undefined
): Logger {
  const streams = destinations.flatMap((destination) => streamEntriesForDestination(destination));
  const effectiveLevel = override ?? lowestDestinationLevel(destinations);
  const base =
    streams.length === 0 || effectiveLevel === 'silent'
      ? pino({ level: effectiveLevel, redact })
      : pino(
          { level: effectiveLevel, redact },
          pino.multistream(streams, {
            dedupe: false
          })
        );
  return asLogger(Object.keys(bindings).length > 0 ? base.child(bindings) : base);
}

function streamEntriesForDestination(destination: LogDestination): StreamEntry[] {
  const level = destination.level ?? 'info';
  if (level === 'silent') return [];
  switch (destination.type) {
    case 'console':
      return [
        {
          level,
          stream:
            destination.pretty && Bun.env.NODE_ENV !== 'production'
              ? pino.transport({
                  target: 'pino-pretty',
                  options: {
                    colorize: true,
                    destination: destination.stream === 'stderr' ? 2 : 1,
                    translateTime: 'SYS:HH:MM:ss',
                    ignore: 'pid,hostname,name,method,path,status,durationMs,transport,transportCall',
                    messageFormat: '{if name}\x1B[2m[{name}]\x1B[0m {end}{msg}',
                    errorLikeObjectKeys: ['err', 'error'],
                    levelFirst: false,
                    singleLine: false
                  }
                })
              : pino.destination({ dest: destination.stream === 'stderr' ? 2 : 1, sync: true })
        }
      ];
    case 'file':
      mkdirSync(dirname(destination.path), { recursive: true });
      return [
        {
          level,
          stream: pino.destination({ dest: destination.path, sync: destination.sync ?? false, append: true })
        }
      ];
    case 'custom':
      return [{ level, stream: customDestinationStream(destination) }];
    case 'developer':
      return [{ level, stream: developerStream }];
    case 'debug-file':
      return [
        {
          level,
          stream: pino.destination({ dest: destination.path ?? debugLogPath, sync: false, append: true })
        }
      ];
  }
}

function customDestinationStream(destination: CustomLogDestination): pino.DestinationStream {
  return {
    write(line: string) {
      let record: LoggerRecord;
      try {
        record = JSON.parse(line) as LoggerRecord;
      } catch {
        return;
      }
      void Promise.resolve(destination.write(record)).catch(() => {});
    }
  };
}

function lowestDestinationLevel(destinations: readonly LogDestination[]): PinoLevel {
  let lowest: PinoLevel = 'silent';
  for (const destination of destinations) {
    const level = destination.level ?? 'info';
    if (LEVEL_RANK[level] < LEVEL_RANK[lowest]) lowest = level;
  }
  return lowest;
}

// createLogger returns a LAZY logger: the underlying pino instance (and therefore its stdout / stderr
// / file destination) is built on first USE, not at this call. Loggers are overwhelmingly created at
// module scope (`const log = createLogger('x')`), which for the daemon runs at import time — before
// the entrypoint calls setLogStderr()/setLogFile() in configureDaemonLogging(). Binding the
// destination eagerly there sent JSON logs to stdout, leaking them into the CLI's stdout relay and
// leaving daemon.log empty. Deferring to first log call reads the flags after they are set.
export function createLogger(name?: string, context?: Record<string, unknown>): Logger {
  let real: Logger | undefined;
  const resolve = (): Logger => (real ??= buildLogger(name, context));
  return new Proxy({} as Logger, {
    get(_target, prop) {
      const value = Reflect.get(resolve(), prop, resolve());
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(resolve()) : value;
    },
    set(_target, prop, value) {
      return Reflect.set(resolve(), prop, value);
    }
  }) as Logger;
}

// pino.Logger structurally satisfies the smaller platform-agnostic Logger surface; the cast pins
// the public type to that surface so consumers never depend on pino specifics.
function asLogger(instance: pino.Logger): Logger {
  return instance as unknown as Logger;
}
