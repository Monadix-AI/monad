/**
 * Monad — a standalone full-agent runtime daemon.
 *
 * Copyright (c) 2026 Monadix Labs, Inc.
 * Released under the MIT License.
 * See LICENSE in the repository root for the full license text.
 *
 * Transports (clients choose the protocol):
 *   HTTP REST+SSE  https://127.0.0.1:52749           (control ops + event stream, TCP)
 *   HTTP REST+SSE  unix:~/.monad/run/monad.sock      (same Elysia app over a Unix socket — the
 *                                                      low-latency local path the CLI uses)
 *   WebSocket      wss://127.0.0.1:52749/v1/stream   (JSON-RPC framing, server-push, TCP only)
 *   stdio          stdin/stdout                      (NDJSON / JSON-RPC, --stdio only)
 *   ACP            stdin/stdout                      (Agent Client Protocol for editors, --acp;
 *                                                      bidirectional peer — see transports/acp/)
 */

import { startDaemon } from '#/application/lifecycle.ts';

export type { App } from '#/application/lifecycle.ts';

export { startDaemon } from '#/application/lifecycle.ts';

if (import.meta.main) {
  startDaemon().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
