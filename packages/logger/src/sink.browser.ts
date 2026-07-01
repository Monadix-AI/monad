// Browser sink: a console-backed shim. Selected by the `#platform-sink` conditional import when a
// bundler resolves the `browser` condition, so pino and every node:* import in sink.node.ts are
// tree-shaken out of the browser bundle. The pipe destination is fixed (the console); env only
// tunes the level threshold, mirroring node's getLogLevel() override.

import type { Logger, LogLevel } from './types.ts';

import { emitDeveloperRecord } from './developer.ts';
import { getLogLevel } from './level.ts';

// (No on-disk descriptors here — those live in ./log-files.ts, a node-only module. The browser sink
// has no filesystem, so it deliberately carries nothing about debug files or developer jsonl.)

export function setDeveloperLogTransport(_opts: { enabled: boolean; dir: string }): void {
  // No filesystem → on-disk capture is a no-op. Live subscribers still receive records (below).
}

const RANK = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60, silent: 100 };
const LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
const INFO_RANK = RANK.info;

function rank(level: string): number {
  return level in RANK ? RANK[level as keyof typeof RANK] : INFO_RANK;
}

function consoleMethod(level: LogLevel): 'debug' | 'info' | 'warn' | 'error' {
  if (level === 'trace' || level === 'debug') return 'debug';
  if (level === 'warn') return 'warn';
  if (level === 'error' || level === 'fatal') return 'error';
  return 'info';
}

// Extract an Error's fields explicitly — a bare `{...err}` spread drops message/stack (they are
// non-enumerable), so this mirrors what pino's err serializer keeps on the node side.
function errorFields(v: unknown): { err: { type: string; message: string; stack?: string } } | undefined {
  return v instanceof Error ? { err: { type: v.name, message: v.message, stack: v.stack } } : undefined;
}

function makeLogger(bindings: Record<string, unknown>, threshold: number): Logger {
  // Broad params (`unknown`) so each method is assignable to the overloaded LogFn; a non-string
  // second arg is simply ignored as a message.
  const emit = (level: LogLevel, a: unknown, b?: unknown) => {
    const levelRank = rank(level);
    const errFields = errorFields(a);
    const obj = typeof a === 'string' || errFields ? undefined : (a as Record<string, unknown>);
    const msg = typeof a === 'string' ? a : typeof b === 'string' ? b : a instanceof Error ? a.message : undefined;
    // `level` is numeric (pino's rank) + a `time` stamp so records satisfy the developer-log wire
    // schema (DeveloperLogRecord.level is z.number()) identically to the node sink.
    const record: Record<string, unknown> = {
      level: levelRank,
      time: Date.now(),
      ...bindings,
      ...obj,
      ...errFields,
      ...(msg ? { msg } : {})
    };
    // Developer-record fan-out matches the node sink: records at debug+ reach subscribers regardless
    // of the console display threshold (node wires developerStream at a fixed 'debug' level).
    // NOTE: unlike the node sink, this does NOT apply pino's REDACT_PATHS backstop — records reach
    // subscribers verbatim. That is fine today (records stay in-process, same user, same machine),
    // but if a browser consumer ever forwards these records off-device, scrub secrets first.
    if (levelRank >= RANK.debug && (typeof record.channelId === 'string' || typeof record.sessionId === 'string')) {
      emitDeveloperRecord(record);
    }
    if (levelRank < threshold) return;
    const name = typeof bindings.name === 'string' ? `[${bindings.name}] ` : '';
    // biome-ignore lint/suspicious/noConsole: the browser sink's whole purpose is to pipe to the console
    console[consoleMethod(level)](`${name}${msg ?? ''}`, record);
  };
  return {
    level: LEVELS.find((l) => rank(l) >= threshold) ?? 'silent',
    trace: (a: unknown, b?: unknown) => emit('trace', a, b),
    debug: (a: unknown, b?: unknown) => emit('debug', a, b),
    info: (a: unknown, b?: unknown) => emit('info', a, b),
    warn: (a: unknown, b?: unknown) => emit('warn', a, b),
    error: (a: unknown, b?: unknown) => emit('error', a, b),
    fatal: (a: unknown, b?: unknown) => emit('fatal', a, b),
    silent: () => {},
    isLevelEnabled: (level: string) => rank(level) >= threshold,
    child: (childBindings: Record<string, unknown>) => makeLogger({ ...bindings, ...childBindings }, threshold)
  };
}

export function createLogger(name?: string, context?: Record<string, unknown>): Logger {
  const bindings = { ...(name ? { name } : {}), ...context };
  return makeLogger(bindings, rank(getLogLevel() ?? 'info'));
}
