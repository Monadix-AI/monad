// Platform-agnostic logging contract. Neither this file nor anything it imports may touch a
// platform API (no node:*, no DOM) — it is shared by every sink (node, browser) and is safe to
// bundle anywhere.

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type LogLevelOverride = LogLevel | 'silent';

/** A pino-style log method: `(obj, msg?)` or `(msg)`. pino's own methods are assignable to this,
 *  so the node sink can return a pino instance directly as a `Logger`. */
interface LogFn {
  (obj: unknown, msg?: string, ...args: unknown[]): void;
  (msg: string, ...args: unknown[]): void;
}

/** The minimal logger surface every consumer relies on — structurally satisfied by pino (node) and
 *  by the console shim (browser). Kept deliberately small so no sink is tied to pino specifics. */
export interface Logger {
  level: string;
  trace: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
  silent: LogFn;
  isLevelEnabled(level: string): boolean;
  child(bindings: Record<string, unknown>): Logger;
}

// The raw, unvalidated record as it leaves the logger. The wire/validated shape is
// `DeveloperLogRecord` in @monad/protocol — consumers parse this into that at the SSE boundary.
export type RawDeveloperLogRecord = Record<string, unknown>;
export type DeveloperLogSubscriber = (record: RawDeveloperLogRecord) => void;

export interface LoggerRecord extends RawDeveloperLogRecord {
  level: number;
  time: number;
  msg?: string;
}

interface BaseLogDestination {
  level?: LogLevelOverride;
}

interface ConsoleLogDestination extends BaseLogDestination {
  type: 'console';
  pretty?: boolean;
  stream?: 'stdout' | 'stderr';
}

export interface FileLogDestination extends BaseLogDestination {
  type: 'file';
  path: string;
  sync?: boolean;
}

export interface CustomLogDestination extends BaseLogDestination {
  type: 'custom';
  name: string;
  write(record: LoggerRecord): void | Promise<void>;
}

export interface DeveloperLogDestination extends BaseLogDestination {
  type: 'developer';
}

interface DebugFileLogDestination extends BaseLogDestination {
  type: 'debug-file';
  path?: string;
}

export type LogDestination =
  | ConsoleLogDestination
  | FileLogDestination
  | CustomLogDestination
  | DeveloperLogDestination
  | DebugFileLogDestination;

export interface LoggerConfig {
  destinations?: readonly LogDestination[];
}

// The platform contract each sink fulfils (createLogger + setDeveloperLogTransport) is enforced
// structurally: index.ts re-exports both from the `#platform-sink` conditional import, so a sink
// missing either fails to compile — no explicit interface needed.
