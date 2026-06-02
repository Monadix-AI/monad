// Must be imported before pino loads — zero dependencies, so it's safe to call
// setLogLevel() at process startup before any dynamic import triggers logger init.

export type LogLevelOverride = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

let _override: LogLevelOverride | undefined;

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
