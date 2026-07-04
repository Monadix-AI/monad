import type { NativeCliAppServerConnection } from '@/services/native-cli/types.ts';

import { createStreamingTextDecoder } from '@/services/native-cli/stream-decoder.ts';

interface DialAppServerWsOptions {
  /** Each inbound WebSocket text frame is one JSON-RPC message (no framing newline). */
  onMessage: (text: string) => void;
  onClose: () => void;
  timeoutMs: number;
}

interface ConnectAppServerWsOptions extends DialAppServerWsOptions {
  /** Child stderr, where an app-server prints `listening on: ws://127.0.0.1:<port>` before serving. */
  stderr: ReadableStream<Uint8Array> | undefined;
  /** Reports the parsed loopback port so the caller can re-dial (reconnect) without re-reading stderr. */
  onPort?: (port: number) => void;
}

const LISTEN_URL = /ws:\/\/[^\s:/]+:(\d+)/;
// Generous upper bound on how long a `ws://host:port` match can be — covers the overlap kept
// between scans so a match split across two stderr chunks is never missed.
const LISTEN_URL_MAX_MATCH_LENGTH = 128;

async function readListenPort(
  stderr: ReadableStream<Uint8Array> | undefined,
  timeoutMs: number
): Promise<{ port: number; carried: string }> {
  if (!stderr) throw new Error('app-server ws transport requires the child stderr stream');
  const decoder = createStreamingTextDecoder();
  const reader = stderr.getReader();
  let buffer = '';
  let scanned = 0;
  const deadline = setTimeout(() => void reader.cancel().catch(() => {}), timeoutMs);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value ? decoder.decode(value) : '';
      // Re-scan only the unscanned tail (plus a small overlap for a match split across chunk
      // boundaries), not the whole growing buffer — otherwise a chatty child that prints a lot
      // of stderr before its listen line makes this O(n^2) over the preamble.
      const scanFrom = Math.max(0, scanned - LISTEN_URL_MAX_MATCH_LENGTH);
      const match = buffer.slice(scanFrom).match(LISTEN_URL);
      scanned = buffer.length;
      if (match) {
        clearTimeout(deadline);
        reader.releaseLock();
        return { port: Number(match[1]), carried: buffer };
      }
    }
  } finally {
    clearTimeout(deadline);
  }
  throw new Error('app-server ws transport: child exited before announcing a listen port');
}

/**
 * Bring up the ws leg of an app-server launch (`appServerTransport: 'ws'`): parse the ephemeral
 * loopback port the child prints on stderr, dial the WebSocket, and expose the transport-neutral
 * `NativeCliAppServerConnection` so the host drives a ws session exactly like a stdio one.
 * Provider-agnostic — the adapter selects this transport via the launch spec, never the daemon by
 * provider id. Resolves once the socket is open; rejects on port-parse or connect timeout so the
 * caller can fail the session cleanly.
 */
export async function connectAppServerWs(opts: ConnectAppServerWsOptions): Promise<NativeCliAppServerConnection> {
  const { port } = await readListenPort(opts.stderr, opts.timeoutMs);
  opts.onPort?.(port);
  return dialAppServerWs(port, opts);
}

/** Dial an already-known loopback port. Used for the initial connect (after the port is parsed from
 *  stderr) and for reconnect, where the child is still listening on the same port. */
export async function dialAppServerWs(
  port: number,
  opts: DialAppServerWsOptions
): Promise<NativeCliAppServerConnection> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('app-server ws transport: connection timed out')), opts.timeoutMs);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('app-server ws transport: connection failed'));
    };
  });
  let closed = false;
  ws.onmessage = (event) => opts.onMessage(typeof event.data === 'string' ? event.data : String(event.data));
  ws.onclose = () => {
    if (closed) return;
    closed = true;
    opts.onClose();
  };
  return {
    send: (frame) => ws.send(frame),
    close: () => {
      closed = true;
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    }
  };
}
