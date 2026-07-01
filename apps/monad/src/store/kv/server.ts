import type { SocketHandler, SocketListener } from 'bun';

import { unlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { type ConnState, handleCommand, makeConnState } from './commands.ts';
import { parseCommand } from './resp.ts';
import { KvStore } from './store.ts';

interface ConnData {
  buf: Buffer;
  state: ConnState;
  connId: number;
}

/**
 * POSIX `redis+unix://` URL for a KV socket path. Bun's format is `redis+unix:///<path>` (the path
 * is the URL pathname), so `pathToFileURL` yields the right `redis+unix:///tmp/kv.sock`. POSIX only —
 * on Windows the server uses TCP loopback (see {@link KvServer.start}) because no single path string
 * is valid for both `Bun.listen({ unix })` and a `redis+unix://` URL (CI-verified).
 */
function kvSocketUrl(sockPath: string): string {
  return `redis+unix://${pathToFileURL(sockPath).pathname}`;
}

/**
 * An OS-assigned free loopback port. Bun's raw `Bun.listen` rejects `port: 0` (oven-sh/bun#1544)
 * and Bun has no free-port API (#25528), but `Bun.serve` DOES support `port: 0` — so bind a
 * throwaway HTTP server to claim a port, read it, and immediately release it. Used for the KV
 * server on Windows, where unix sockets aren't available (named pipes — oven-sh/bun#13042).
 */
function freeLoopbackPort(): number {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);
  if (port == null) throw new Error('kv: could not obtain a free loopback port');
  return port;
}

/** Emitted for every command received, in arrival order. Powers tracing + the debug monitor. */
export interface CommandEvent {
  ts: number; // unix ms
  connId: number; // per-connection id, monotonic within a server
  args: string[]; // raw command + arguments, e.g. ['SET', 'k', 'v']
}

export type CommandObserver = (event: CommandEvent) => void;

export interface KvServerOptions {
  /** Background sweep interval in ms (default 30 000). */
  sweepIntervalMs?: number;
}

export class KvServer {
  readonly store = new KvStore();
  #server: SocketListener<ConnData> | null = null;
  #sweepTimer: ReturnType<typeof setInterval> | null = null;
  #observers = new Set<CommandObserver>();
  #nextConnId = 1;
  #clientUrl = '';
  #socket: SocketHandler<ConnData> | null = null;
  #sockPath: string | null = null;

  /** The `Bun.RedisClient` URL a client dials to reach this server. Valid after start(). A Unix
   *  socket (`redis+unix://…`) when one was bound and the client can dial it; TCP loopback
   *  (`redis://127.0.0.1:<port>`) after {@link bindTcpFallback}. */
  get clientUrl(): string {
    return this.#clientUrl;
  }

  /** Observe every command as it arrives. Returns an unsubscribe fn. Free when no observers are registered. */
  onCommand(observer: CommandObserver): () => void {
    this.#observers.add(observer);
    return () => this.#observers.delete(observer);
  }

  start(sockPath: string, opts?: KvServerOptions): void {
    if (this.#server) throw new Error('KvServer already started');

    const store = this.store;
    const emit = (connId: number, args: string[]): void => {
      if (this.#observers.size === 0) return;
      const event: CommandEvent = { ts: Date.now(), connId, args };
      for (const observer of [...this.#observers]) observer(event);
    };

    const socket: SocketHandler<ConnData> = {
      open: (s) => {
        s.data = { buf: Buffer.alloc(0), state: makeConnState(), connId: this.#nextConnId++ };
      },

      data(s, rawChunk) {
        // Accumulate bytes, then drain all complete commands
        s.data.buf =
          s.data.buf.length === 0 ? Buffer.from(rawChunk) : Buffer.concat([s.data.buf, Buffer.from(rawChunk)]);

        let parsed = parseCommand(s.data.buf);
        while (parsed !== null) {
          s.data.buf = parsed.rest;
          emit(s.data.connId, parsed.args);
          const response = handleCommand(parsed.args, s.data.state, store, s);
          // null = the handler will write asynchronously (push-mode or blocked XREAD)
          if (response !== null) s.write(response);
          parsed = parseCommand(s.data.buf);
        }
      },

      close(s) {
        for (const unsub of s.data.state.subs.values()) unsub();
        s.data.state.subs.clear();
        for (const cleanup of [...s.data.state.blocked]) cleanup();
        s.data.state.blocked.clear();
      },

      error(_s, err) {
        // biome-ignore lint/suspicious/noConsole: socket-level error
        console.error('[kv] socket error:', err.message);
      }
    };

    this.#socket = socket;
    this.#sockPath = sockPath;

    // Prefer a Unix-domain socket on every platform (Bun supports AF_UNIX on Windows too). Fall back
    // to a TCP loopback listener only if the socket can't be bound — keeping the KV server reachable
    // in any environment where AF_UNIX is unavailable. (A bound socket whose CLIENT can't dial it —
    // Bun.RedisClient rejects `redis+unix://` URLs on Windows — is handled by bindTcpFallback.)
    try {
      // A non-graceful exit (crash, SIGKILL) leaves the socket file behind; Bun.listen({unix})
      // would then fail with EADDRINUSE. Remove the stale node first.
      try {
        unlinkSync(sockPath);
      } catch {
        // no stale socket — first start, or already cleaned up
      }
      this.#server = Bun.listen<ConnData>({ unix: sockPath, socket });
      this.#clientUrl = kvSocketUrl(sockPath);
    } catch {
      // AF_UNIX unavailable — run the RESP server on TCP loopback instead. Bun.listen rejects port:0
      // (#1544), so claim a free port via Bun.serve first. Loopback-only, same local-only exposure.
      const port = freeLoopbackPort();
      this.#server = Bun.listen<ConnData>({ hostname: '127.0.0.1', port, socket });
      this.#clientUrl = `redis://127.0.0.1:${port}`;
    }

    const intervalMs = opts?.sweepIntervalMs ?? 30_000;
    this.#sweepTimer = setInterval(() => this.store.sweep(), intervalMs);
  }

  /**
   * Re-bind on TCP loopback after the Unix-socket listener bound but its CLIENT couldn't connect —
   * `Bun.RedisClient` rejects `redis+unix://` URLs on Windows even though `Bun.listen({ unix })`
   * succeeds there. Reuses the same handler + store (only the transport changes) and returns the new
   * `clientUrl`. No-op if already on TCP.
   */
  bindTcpFallback(): string {
    if (this.#clientUrl.startsWith('redis://')) return this.#clientUrl;
    if (!this.#socket) throw new Error('KvServer not started');
    this.#server?.stop(true);
    // The Unix listener bound, so its socket node exists on disk — remove it now that we're abandoning
    // it, matching the stale-node cleanup the unix path does before every bind.
    if (this.#sockPath) {
      try {
        unlinkSync(this.#sockPath);
      } catch {
        // already gone
      }
    }
    const port = freeLoopbackPort();
    this.#server = Bun.listen<ConnData>({ hostname: '127.0.0.1', port, socket: this.#socket });
    this.#clientUrl = `redis://127.0.0.1:${port}`;
    return this.#clientUrl;
  }

  stop(): void {
    if (this.#sweepTimer) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = null;
    }
    this.#server?.stop(true);
    this.#server = null;
    this.#observers.clear();
  }
}
