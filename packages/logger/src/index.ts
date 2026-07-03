// Platform-agnostic logging façade. The concrete sink (node/pino vs browser/console) is chosen at
// build time via the `#platform-sink` conditional import in package.json, so a browser bundle never
// pulls pino or node:* and a node bundle never carries the console shim — each tree-shakes the
// other out. Everything re-exported here is safe to import from mac/linux/win/browser alike.
//
// Log LEVEL is controlled via setLogLevel()/setLogStderr()/setLogFile() (see ./level.ts) and read by
// the sink; the pipe DESTINATION is the sink's concern (node resolves stdout/stderr/file per write;
// browser always uses the console). On-disk log lifecycle (rotation, retention) is NOT this package's
// responsibility — it belongs to whoever owns the log directory (the daemon).

import { createLogger } from '#platform-sink';

export type { DeveloperLogSubscriber, Logger, LogLevel, RawDeveloperLogRecord } from './types.ts';

export { createLogger, setDeveloperLogTransport } from '#platform-sink';
export { subscribeDeveloperLogRecords } from './developer.ts';
export { formatPrettyMessage, formatTransportCall } from './format.ts';
export { type LogLevelOverride, setLogFile, setLogLevel, setLogStderr } from './level.ts';

export const logger = createLogger('monad');

// Node-only on-disk log-file descriptors (locations + filename matchers) are intentionally NOT
// re-exported here — they don't belong on the platform-agnostic surface. Import them from the
// `@monad/logger/log-files` subpath (node bundles only); see ./log-files.ts.
