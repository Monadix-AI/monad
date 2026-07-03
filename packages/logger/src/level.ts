// Must be imported before pino loads — zero dependencies, so it's safe to call
// setLogLevel() at process startup before any dynamic import triggers logger init.

import type { LoggerConfig, LogLevelOverride } from './types.ts';

export type { LogLevelOverride };

let _override: LogLevelOverride | undefined;
let _config: LoggerConfig | undefined;

export function configureLogger(config?: LoggerConfig): void {
  _config = config;
}

export function getLoggerConfig(): LoggerConfig | undefined {
  return _config;
}

export function setLogLevel(level: LogLevelOverride): void {
  _override = level;
}

export function getLogLevel(): LogLevelOverride | undefined {
  return _override;
}

// When stdout is a protocol channel (stdio/ACP transports), logs MUST go to stderr instead, or
// they corrupt the JSON-RPC stream. Set this before the first createLogger() call.
let _stderr = false;

export function setLogStderr(on: boolean): void {
  _stderr = on;
}

export function getLogStderr(): boolean {
  return _stderr;
}

// When set, the production info+ log stream is written to this file instead of stdout/stderr. The
// daemon uses this for `monad start` (--start-relay): stdout is reserved for the banner the CLI
// relays, and the daemon owns writing its own daemon.log — which, unlike the parent redirecting the
// child's stderr fd, works for a detached child on Windows too. Set before the first log call.
let _logFile: string | undefined;

export function setLogFile(path: string | undefined): void {
  _logFile = path;
}

export function getLogFile(): string | undefined {
  return _logFile;
}
