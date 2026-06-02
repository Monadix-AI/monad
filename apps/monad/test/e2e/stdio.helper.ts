// Spawned by stdio.test.ts: a minimal monad daemon over real stdin/stdout, backed by the mock
// model. The test drives it via raw JSON-RPC NDJSON over the process pipes — the same wire
// path an embedded host (IDE, shell script) uses with --stdio.
//
// setLogStderr(true) must run before any module-level createLogger() call fires — dynamic
// imports below ensure that ordering (same pattern as --stdio startup in main.ts).

import { setLogStderr } from '@monad/logger';

setLogStderr(true);

const { startStdioTransport } = await import('@/transports/stdio.ts');
const { buildHandlers, mockModel } = await import('../helpers.ts');

await startStdioTransport(buildHandlers(mockModel()));
