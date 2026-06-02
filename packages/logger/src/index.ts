import { mkdirSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';

import { getLogLevel, getLogStderr } from './level.ts';

export type Logger = pino.Logger;
export type LogLevel = pino.Level;
type PinoLevel = pino.Level | 'silent';
type LogRecord = Record<string, unknown>;
// The raw, unvalidated pino record as it leaves the logger. The wire/validated shape is
// `DeveloperLogRecord` in @monad/protocol — consumers parse this into that at the SSE boundary.
export type RawDeveloperLogRecord = LogRecord;
export type DeveloperLogSubscriber = (record: RawDeveloperLogRecord) => void;
type PrettyRecord = LogRecord & {
  durationMs?: unknown;
  err?: unknown;
  error?: unknown;
  method?: unknown;
  msg?: unknown;
  name?: unknown;
  path?: unknown;
  status?: unknown;
  transport?: unknown;
};

export { type LogLevelOverride, setLogLevel, setLogStderr } from './level.ts';

/** Daily-rotating debug log in OS temp dir (prod only). */
export const debugLogPath: string = join(tmpdir(), `monad-debug-${new Date().toISOString().slice(0, 10)}.log`);

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
const reset = '\x1B[0m';
const dim = (s: string) => `\x1B[2m${s}${reset}`;
const cyan = (s: string) => `\x1B[36m${s}${reset}`;
const green = (s: string) => `\x1B[32m${s}${reset}`;
const yellow = (s: string) => `\x1B[33m${s}${reset}`;
const red = (s: string) => `\x1B[31m${s}${reset}`;
const magenta = (s: string) => `\x1B[35m${s}${reset}`;
const bold = (s: string) => `\x1B[1m${s}${reset}`;

let developerLogDir: string | null = null;
const developerLogSubscribers = new Set<DeveloperLogSubscriber>();

export function subscribeDeveloperLogRecords(subscriber: DeveloperLogSubscriber): () => void {
  developerLogSubscribers.add(subscriber);
  return () => developerLogSubscribers.delete(subscriber);
}

const developerStream: pino.DestinationStream = {
  write(line: string) {
    // Nothing consumes the record (no live SSE subscriber, no on-disk dir) — skip the per-record
    // JSON.parse entirely. developerStream is wired at debug level, so this runs on every record.
    if (!developerLogDir && developerLogSubscribers.size === 0) return;
    let record: LogRecord;
    try {
      record = JSON.parse(line) as LogRecord;
    } catch {
      return;
    }
    const channelId = typeof record.channelId === 'string' ? record.channelId : undefined;
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId : undefined;
    const id = channelId ?? sessionId;
    if (!id) return;
    for (const subscriber of developerLogSubscribers) subscriber(record);
    if (!developerLogDir) return;
    const scope = channelId ? 'channel' : 'session';
    const file = join(developerLogDir, `${scope}-${safeLogId(id)}.jsonl`);
    void appendFile(file, line.endsWith('\n') ? line : `${line}\n`, 'utf8').catch(() => {});
  }
};

export function setDeveloperLogTransport(opts: { enabled: boolean; dir: string }): void {
  developerLogDir = opts.enabled ? opts.dir : null;
  if (developerLogDir) mkdirSync(developerLogDir, { recursive: true });
}

export function formatPrettyMessage(record: PrettyRecord): string {
  const transport = transportName(record);
  if (!transport) {
    const name = typeof record.name === 'string' && record.name.length > 0 ? `${dim(`[${record.name}]`)} ` : '';
    return `${name}${String(record.msg ?? '')}`;
  }

  return `${dim(`[transport:${transport}]`)} ${formatTransportCall(record)}`;
}

export function formatTransportCall(record: PrettyRecord): string {
  const method = typeof record.method === 'string' ? record.method : String(record.method ?? 'call');
  const duration = typeof record.durationMs === 'number' ? ` ${dim('in')} ${magenta(`${record.durationMs}ms`)}` : '';
  if (typeof record.status === 'number' || typeof record.path === 'string') {
    const status = typeof record.status === 'number' ? ` ${statusColor(record.status)(String(record.status))}` : '';
    const path = typeof record.path === 'string' ? ` ${cyan(record.path)}` : '';
    return `${bold(method)}${status}${path}${duration}`;
  }
  const state = record.err || record.error ? red('error') : green('ok');
  return `${cyan(method)} ${state}${duration}`;
}

export function createLogger(name?: string, context?: Record<string, unknown>): Logger {
  const bindings = { ...(name ? { name } : {}), ...context };
  const LOG_LEVEL_OVERRIDE = getLogLevel() as PinoLevel | undefined;

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
            { level: level as LogLevel, stream: pino.destination({ dest, sync: true }) },
            { level: 'debug' as LogLevel, stream: developerStream }
          ],
          { dedupe: false }
        )
      );
      return Object.keys(bindings).length > 0 ? base.child(bindings) : base;
    }
    const pretty = level === 'silent' ? undefined : pino.transport(devTransport);
    const base =
      pretty === undefined
        ? pino({ level, redact })
        : pino(
            { level, redact },
            pino.multistream(
              [
                { level: level === 'silent' ? 'silent' : (level as LogLevel), stream: pretty },
                { level: 'debug' as LogLevel, stream: developerStream }
              ],
              { dedupe: false }
            )
          );
    return Object.keys(bindings).length > 0 ? base.child(bindings) : base;
  }

  // Production: info+ → stdout (NDJSON), debug+ → rotating temp file
  const effectiveLevel: PinoLevel = LOG_LEVEL_OVERRIDE ?? 'info';
  const streams = pino.multistream(
    [
      {
        level: effectiveLevel === 'silent' ? 'silent' : ('info' as LogLevel),
        stream: dest === 2 ? process.stderr : process.stdout
      },
      {
        level: 'debug' as LogLevel,
        stream: pino.destination({ dest: debugLogPath, sync: false, append: true })
      },
      {
        level: 'debug' as LogLevel,
        stream: developerStream
      }
    ],
    { dedupe: true }
  );

  const base = pino({ level: effectiveLevel === 'silent' ? 'silent' : 'debug', redact }, streams);
  return Object.keys(bindings).length > 0 ? base.child(bindings) : base;
}

export const logger: Logger = createLogger('monad');

function safeLogId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.:-]/g, '_');
}

function transportName(record: PrettyRecord): string | undefined {
  if (typeof record.transport === 'string' && record.transport.length > 0) return record.transport;
  if (typeof record.name === 'string' && record.name.startsWith('transport:'))
    return record.name.slice('transport:'.length);
  return undefined;
}

function statusColor(status: number): (s: string) => string {
  if (status >= 500) return red;
  if (status >= 400) return yellow;
  if (status >= 300) return cyan;
  if (status >= 200) return green;
  return magenta;
}
