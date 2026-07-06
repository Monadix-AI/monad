import type { createDaemonHandlers } from '@/handlers/daemon-handlers/index.ts';
import type { ConnectionState } from '@/transports/jsonrpc/index.ts';

import { Elysia } from 'elysia';

import { isBrowserRequestAllowed } from '@/transports/http/browser-guard.ts';
import { getStreamSocketId } from '@/transports/http/stream/model.ts';
import { closeConnection, createConnectionState, handleRpcMessage } from '@/transports/jsonrpc/index.ts';

// Browser-facing WS gets a token-bucket rate limit: a 100-request burst, then a
// sustained 50 req/s — far above any legitimate UI, but caps a flooding socket.
const WS_RATE_LIMIT = { capacity: 100, refillPerSec: 50 };

// A stalled WS consumer must not grow the daemon's memory: server-push fills Bun's socket send
// buffer faster than it drains. Past this many buffered bytes we drop the socket — the client
// reconnects and resubscribes with afterEventId, so persisted events resume losslessly.
const WS_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

// Elysia's ws wrapper doesn't expose Bun's backpressure API; the real ServerWebSocket is `.raw`.
export type StreamWs = {
  send: (data: string) => unknown;
  close?: () => void;
  raw?: { getBufferedAmount?: () => number };
};

/**
 * Send a JSON-RPC message and, if the socket's send buffer has grown past the cap, drop the
 * consumer (Elysia's close → closeConnection disposes its subscriptions, stopping the push).
 * Exported for unit testing.
 */
export function pushBounded(ws: StreamWs, state: ConnectionState, msg: unknown): void {
  if (state.dropped) return;
  ws.send(JSON.stringify(msg));
  if ((ws.raw?.getBufferedAmount?.() ?? 0) > WS_MAX_BUFFERED_BYTES) {
    state.dropped = true;
    ws.close?.();
  }
}

export function createStreamController(
  handlers: ReturnType<typeof createDaemonHandlers>,
  connections: Map<string, ConnectionState>,
  remoteEnabled: boolean
) {
  return new Elysia().ws('/stream', {
    // Guards against CSWSH + DNS rebinding (browsers can open ws:// cross-origin).
    beforeHandle({ request }: { request: Request }) {
      if (!isBrowserRequestAllowed(request, { remoteEnabled })) {
        return new Response('Forbidden origin', { status: 403 });
      }
    },
    open(ws: unknown) {
      connections.set(getStreamSocketId(ws), createConnectionState(WS_RATE_LIMIT));
    },
    message(ws: { send: (data: string) => unknown }, raw: unknown) {
      const id = getStreamSocketId(ws);
      const state = connections.get(id);
      if (!state) return;

      // Elysia types `ws` minimally here; the live socket also carries `.raw`/`.close` (Bun's
      // ServerWebSocket), which pushBounded uses for backpressure. Cast to reach them.
      const sock = ws as StreamWs;
      const rawStr = typeof raw === 'string' ? raw : JSON.stringify(raw);
      handleRpcMessage(rawStr, state, handlers, (msg) => pushBounded(sock, state, msg), 'ws').catch((err: unknown) => {
        process.stderr.write(`ws rpc error: ${err}\n`);
      });
    },
    close(ws: unknown) {
      const id = getStreamSocketId(ws);
      const state = connections.get(id);
      if (state) closeConnection(state);
      connections.delete(id);
    }
  });
}
