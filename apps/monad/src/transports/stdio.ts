// stdio transport — newline-delimited JSON-RPC on stdin/stdout.
// Only active when --stdio flag is passed.
// stdout is exclusively the RPC channel; all daemon logs MUST go to stderr.
// Framing: one JSON-RPC message per line (\n terminated).

import type { JsonRpcNotification, JsonRpcResponse } from '@monad/protocol';
import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';

import { closeConnection, createConnectionState, handleRpcMessage } from '#/transports/jsonrpc/index.ts';

export async function startStdioTransport(handlers: ReturnType<typeof createDaemonHandlers>): Promise<void> {
  const state = createConnectionState();
  const decoder = new TextDecoder();

  const push = (msg: JsonRpcResponse | JsonRpcNotification) => {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  };

  let buf = '';
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk);
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl === -1) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) {
        // Sequential await — a single stdio connection cannot race with itself.
        await handleRpcMessage(line, state, handlers, push, 'stdio');
      }
    }
  }

  // stdin EOF — tear down all active subscriptions.
  closeConnection(state);
}
