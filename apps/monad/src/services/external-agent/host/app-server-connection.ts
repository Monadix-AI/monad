import type { Logger } from '@monad/logger';
import type { Event } from '@monad/protocol';
import type { LiveExternalAgentSession } from '#/services/external-agent/host/host-types.ts';

import { chmodSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ExternalAgentError } from '#/services/external-agent/errors.ts';
import {
  APP_SERVER_DISCONNECT_GRACE_MS,
  APP_SERVER_MAX_DISCONNECT_CYCLES,
  APP_SERVER_RECONNECT_ATTEMPTS,
  APP_SERVER_RECONNECT_BASE_MS,
  APP_SERVER_RECONNECT_STREAK_RESET_MS
} from '#/services/external-agent/host/host-constants.ts';

export interface ExternalAgentAppServerConnectionContext {
  live: Map<string, LiveExternalAgentSession>;
  emit(sessionId: string, type: Event['type'], payload: Record<string, unknown>): void;
  stop(id: string): void;
  log: Logger;
  reconnectBaseMs?: number;
  disconnectGraceMs?: number;
  rotateLiveCapture?(live: LiveExternalAgentSession): void;
}

/** Owns the app-server byte-channel lifecycle for `unix`/`ws` sessions: socket/port allocation,
 *  racing a connect attempt against the child exiting, and the disconnect→redial→give-up flow. */
export class ExternalAgentAppServerConnectionManager {
  constructor(private readonly ctx: ExternalAgentAppServerConnectionContext) {}

  /** Allocate the AF_UNIX socket path a `unix` app-server child will listen on. The path must stay
   *  under the OS SUN_LEN limit and sit in a real (non-symlink) directory codex is willing to bind in
   *  — a private, owner-only subdir of the resolved temp dir satisfies both (macOS `/tmp` is a symlink
   *  and codex refuses to bind directly in the sticky temp root). */
  allocateSocketPath(id: string): string {
    const dir = join(realpathSync(tmpdir()), 'monad-appserver');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode is a no-op if the dir already exists (e.g. a looser dir pre-created by another
    // local user in a shared tmp), so tighten it explicitly to owner-only.
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* not chmod-able (e.g. Windows) */
    }
    const path = join(dir, `${id.replace(/[^a-zA-Z0-9]/g, '').slice(-12)}.sock`);
    if (Buffer.byteLength(path) > 100) {
      throw new ExternalAgentError(
        'unsupported_capability',
        'app-server unix socket path exceeds the OS limit; use the stdio or ws transport'
      );
    }
    rmSync(path, { force: true });
    return path;
  }

  /** Pick a free loopback TCP port for a `ws` app-server the daemon wants to assign an explicit
   *  `--port` to (see `ExternalAgentAppServerWsHints.port`) rather than parsing a self-announced one. Binds
   *  to port 0 and immediately releases it — a standard, small-window TOCTOU (acceptable for a
   *  same-process child the daemon spawns milliseconds later) rather than a hard guarantee. */
  allocatePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        server.close(() => {
          if (address && typeof address === 'object') resolve(address.port);
          else reject(new Error('app-server ws transport: could not allocate a loopback port'));
        });
      });
    });
  }

  unlinkSocket(socketPath: string | undefined): void {
    if (!socketPath) return;
    try {
      rmSync(socketPath, { force: true });
    } catch {
      /* already gone */
    }
  }

  /** Consume-and-discard a child stream. For ws app-server sessions the protocol arrives over the
   *  WebSocket, so stdout/stderr are only logs — but they must still be drained or a full pipe buffer
   *  will stall the child. */
  drainStream(stream: ReadableStream<Uint8Array> | undefined): void {
    if (!stream) return;
    void (async () => {
      try {
        const reader = stream.getReader();
        for (;;) {
          const { done } = await reader.read();
          if (done) return;
        }
      } catch {
        /* stream closed */
      }
    })();
  }

  /** Race an app-server connect attempt against the child exiting. Without this, a child that crashes
   *  immediately after spawn (missing dependency, port stolen between allocation and bind, etc.) is only
   *  noticed once the connect's own timeout elapses — the daemon keeps retrying against a port that will
   *  never open for the full app-server startup timeout instead of failing within milliseconds. */
  async raceAgainstExit<T>(connect: Promise<T>, exited: Promise<number>): Promise<T> {
    let settled = false;
    const exitGuard = exited.then((code) => {
      if (settled) return undefined as T;
      throw new Error(`external agent process exited (code ${code}) before the app-server became ready`);
    });
    try {
      return await Promise.race([connect, exitGuard]);
    } finally {
      settled = true;
    }
  }

  private emitReconnectRequired(id: string, live: LiveExternalAgentSession): void {
    this.ctx.emit(live.transcriptTargetId, 'external_agent.connection_required', {
      externalAgentSessionId: id,
      agentName: live.agentName,
      provider: live.provider,
      code: 'app_server_connection_dropped',
      reason: `${live.provider} app-server connection dropped`,
      reconnectIn: 'studio'
    });
  }

  /** An app-server byte channel closed on its own. On loopback this is almost always the child
   *  exiting — `proc.exited` handles that within the grace window and records the real exit state. If
   *  the session is still live after the grace the child is alive but the socket dropped: re-dial the
   *  same socket and re-establish the thread via `thread/resume`. Only if reconnect fails do we tear
   *  the session down and prompt a manual reconnect. A drop during startup (no thread yet) fails fast. */
  handleDisconnect(id: string): void {
    if (!this.ctx.live.has(id)) return;
    setTimeout(() => {
      const current = this.ctx.live.get(id);
      // A suspended (idle) session has already torn down its connection on purpose — a disconnect
      // notice racing that teardown must not re-trigger reconnect/give-up and stop() the session out
      // from under a pending resume.
      if (!current || current.appServerReconnecting || current.suspended) return;
      this.ctx.log.warn(
        {
          sessionId: current.transcriptTargetId,
          event: 'external_agent.app_server_disconnected',
          externalAgentSessionId: id,
          provider: current.provider
        },
        'native cli app-server socket dropped while the process is still alive'
      );
      this.ctx.rotateLiveCapture?.(current);
      // A gateway can close the socket on its very first handshake attempt (for example, rejecting
      // `connect` with `retryable:true` while sidecar plugins are still loading, then dropping the
      // connection) — redial first if the launch mode supports it, even while `live.startup` is still
      // pending. `reconnectAppServer`'s own bounded attempts keep this fast, and its failure path already
      // calls `stop()`, which rejects a still-pending `startup` with a clear message — so this doesn't
      // weaken the original guarantee, it just gives a slow-starting gateway a few quick retries first.
      //
      // `reconnectAppServer` declares success as soon as the socket TRANSPORT reopens, before the
      // app-level handshake completes — so its own attempt counter only bounds transport-dial failures
      // within ONE call. A gateway whose socket keeps reopening but whose handshake keeps failing (e.g.
      // an adapter that swallows a transient handshake rejection expecting the resulting socket-close to
      // trigger redial) would restart that counter every cycle and never reach an exhaustion path.
      // `appServerDisconnectCycles` is the cross-invocation ceiling that closes that gap.
      if (current.appServerStreakResetTimer) {
        clearTimeout(current.appServerStreakResetTimer);
        current.appServerStreakResetTimer = undefined;
      }
      if (current.appServerRedial) {
        current.appServerDisconnectCycles = (current.appServerDisconnectCycles ?? 0) + 1;
        if (current.appServerDisconnectCycles <= APP_SERVER_MAX_DISCONNECT_CYCLES) {
          void this.reconnect(id);
          return;
        }
        this.ctx.log.warn(
          {
            sessionId: current.transcriptTargetId,
            event: 'external_agent.app_server_reconnect_churn_exceeded',
            externalAgentSessionId: id,
            provider: current.provider,
            cycles: current.appServerDisconnectCycles
          },
          'native cli app-server exceeded its reconnect churn budget — giving up'
        );
      }
      if (current.startup) {
        clearTimeout(current.startup.timeout);
        current.startup.reject(new Error(`external agent app-server socket dropped before ready: ${id}`));
        current.startup = undefined;
        this.ctx.stop(id);
        return;
      }
      this.emitReconnectRequired(id, current);
      this.ctx.stop(id);
    }, this.ctx.disconnectGraceMs ?? APP_SERVER_DISCONNECT_GRACE_MS);
  }

  /** Re-dial the app-server socket and resume the thread, with a few backoff attempts. On success the
   *  session keeps running on the fresh connection; on exhaustion it is torn down with a reconnect
   *  prompt. Stale request ids from the dropped socket are cleared — their responses will never come. */
  private async reconnect(id: string): Promise<void> {
    const live = this.ctx.live.get(id);
    if (!live?.appServerRedial || live.appServerReconnecting) return;
    live.appServerReconnecting = true;
    for (let attempt = 1; attempt <= APP_SERVER_RECONNECT_ATTEMPTS; attempt++) {
      if (!this.ctx.live.has(id)) return; // torn down meanwhile
      await Bun.sleep((this.ctx.reconnectBaseMs ?? APP_SERVER_RECONNECT_BASE_MS) * attempt);
      const current = this.ctx.live.get(id);
      if (!current?.appServerRedial) return;
      try {
        const connection = await current.appServerRedial();
        current.appServer = connection;
        current.pendingRequests.clear();
        current.appServerReconnecting = false;
        current.adapter.initialize?.(current, {
          ...(current.initializeContext ?? { workingPath: '' }),
          providerSessionRef: current.providerSessionRef ?? undefined
        });
        // This call only proves the socket TRANSPORT reopened, not that the app-level handshake will
        // succeed — so don't reset the churn counter yet. Reset it once this connection survives a
        // stretch without dropping again; a fresh disconnect cancels this timer (see
        // `handleAppServerDisconnect`), so a persistently-flapping gateway can't reset its own count by
        // surviving just long enough between drops.
        current.appServerStreakResetTimer = setTimeout(() => {
          const stillLive = this.ctx.live.get(id);
          if (stillLive) {
            stillLive.appServerDisconnectCycles = 0;
            stillLive.appServerStreakResetTimer = undefined;
          }
        }, APP_SERVER_RECONNECT_STREAK_RESET_MS);
        current.appServerStreakResetTimer.unref();
        this.ctx.log.debug(
          {
            sessionId: current.transcriptTargetId,
            event: 'external_agent.app_server_reconnected',
            externalAgentSessionId: id
          },
          'native cli app-server reconnected'
        );
        return;
      } catch {
        /* retry */
      }
    }
    const current = this.ctx.live.get(id);
    if (current) {
      current.appServerReconnecting = false;
      this.emitReconnectRequired(id, current);
      this.ctx.stop(id);
    }
  }
}
