// Node-only: the on-disk locations and filenames this package writes. Deliberately kept OFF the
// platform-agnostic surface (index.ts) so the browser sink carries none of it. The daemon's
// log-maintenance layer imports these via the `@monad/logger/log-files` subpath to locate and prune
// exactly what the node sink writes — writer and matcher share this one source, so they can't drift.

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { safeLogId } from './developer.ts';

/** Directory the daily debug log lives in (OS temp dir). */
export const debugLogDir: string = tmpdir();
const DEBUG_LOG_PREFIX = 'monad-debug-';
/** Daily-rotating debug log in the OS temp dir (prod only). */
export const debugLogPath: string = join(
  debugLogDir,
  `${DEBUG_LOG_PREFIX}${new Date().toISOString().slice(0, 10)}.log`
);

/** True for a daily debug-log filename this package produces (e.g. `monad-debug-2026-07-01.log`). */
export function isDebugLogFileName(name: string): boolean {
  return name.startsWith(DEBUG_LOG_PREFIX) && name.endsWith('.log');
}

const DEV_LOG_SUFFIX = '.jsonl';
export type DeveloperLogScope = 'channel' | 'session';

/** Filename for a per-session/channel developer-record file (the writer's single source of truth). */
export function developerLogFileName(scope: DeveloperLogScope, id: string): string {
  return `${scope}-${safeLogId(id)}${DEV_LOG_SUFFIX}`;
}

/** True for a developer-record filename produced by developerLogFileName (matches its exact shape). */
export function isDeveloperLogFileName(name: string): boolean {
  return (name.startsWith('channel-') || name.startsWith('session-')) && name.endsWith(DEV_LOG_SUFFIX);
}
