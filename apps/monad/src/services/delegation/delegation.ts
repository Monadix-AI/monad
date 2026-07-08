// Reverse fs/terminal delegation for the ACP bridge. Like oversight/clarify (see oversight.ts), this
// is a server-initiated request the client must answer — modelled as an out-of-band event + an inbound
// RPC rather than reverse-RPC over the wire. When an ACP editor advertises fs/terminal capability, the
// daemon installs the REMOTE backends below for that session; a delegated fs/shell tool call emits a
// `delegation.{fs,terminal}_request` event (bridged to the editor over the turn's stream), and the
// editor answers via the `delegation.respond` RPC (streaming terminal output via `delegation.output`).

import type { Event, SessionId } from '@monad/protocol';
import type { FsBackend, TerminalBackend, TerminalExecResult } from '@/capabilities/tools/types.ts';

import { newId } from '@monad/protocol';

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  sessionId: SessionId;
  /** Set for terminal requests — receives cumulative output as the command runs. */
  onOutput?: (output: string) => void;
}

export interface DelegationOptions {
  /** Publish an event to the bus ONLY (delegation events are ephemeral RPC — never persisted). */
  publish: (event: Event) => void;
  /** Reject a request with no response after this long. Default 120_000ms. */
  timeoutMs?: number;
  /** Cap on concurrent pending requests. Default 200. */
  maxPending?: number;
}

export class DelegationService {
  private readonly pending = new Map<string, Pending>();
  private readonly publish: (event: Event) => void;
  private readonly timeoutMs: number;
  private readonly maxPending: number;

  constructor(opts: DelegationOptions) {
    this.publish = opts.publish;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.maxPending = opts.maxPending ?? 200;
  }

  /** Ask the client to perform an fs op; resolves with its result ({content} | {path,bytesWritten}). */
  requestFs(
    sessionId: SessionId,
    payload: { op: 'read' | 'write'; path: string; offset?: number; limit?: number; content?: string }
  ): Promise<unknown> {
    return this.request(sessionId, 'delegation.fs_request', payload, this.timeoutMs);
  }

  /** Ask the client to run a terminal command; `onOutput` streams cumulative output until it resolves. */
  requestTerminal(
    sessionId: SessionId,
    payload: { command: string | string[]; cwd?: string; timeoutMs?: number },
    onOutput?: (output: string) => void
  ): Promise<TerminalExecResult> {
    // The command's own timeout governs; give the round-trip headroom beyond it before we give up.
    const deadline = payload.timeoutMs ? payload.timeoutMs + 30_000 : this.timeoutMs;
    return this.request(
      sessionId,
      'delegation.terminal_request',
      payload,
      deadline,
      onOutput
    ) as Promise<TerminalExecResult>;
  }

  private request(
    sessionId: SessionId,
    type: 'delegation.fs_request' | 'delegation.terminal_request',
    payload: Record<string, unknown>,
    timeoutMs: number,
    onOutput?: (output: string) => void
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (this.pending.size >= this.maxPending) {
        reject(new Error('too many pending delegation requests'));
        return;
      }
      const requestId = newId('dlg');
      const timer = setTimeout(() => {
        if (this.pending.delete(requestId)) reject(new Error('delegation request timed out'));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer, sessionId, onOutput });
      this.emit(sessionId, type, { requestId, ...payload });
    });
  }

  /** Resolve a pending request with the client's result (ok) or reject it (error). */
  respond(requestId: string, ok: boolean, result?: unknown, error?: string): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    if (ok) p.resolve(result);
    else p.reject(new Error(error ?? 'delegation rejected by client'));
    return true;
  }

  /** Feed incremental terminal output to a pending request (no resolution). */
  output(requestId: string, output: string): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    p.onOutput?.(output);
    return true;
  }

  /** Reject all pending requests for a session (on abort/delete) so tools don't hang. */
  cancelSession(sessionId: SessionId, reason = 'session_cancelled'): void {
    for (const [requestId, p] of this.pending) {
      if (p.sessionId !== sessionId) continue;
      clearTimeout(p.timer);
      this.pending.delete(requestId);
      p.reject(new Error(reason));
    }
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private emit(sessionId: SessionId, type: Event['type'], payload: Record<string, unknown>): void {
    this.publish({
      id: newId('evt'),
      sessionId,
      type,
      actorAgentId: null,
      payload,
      at: new Date().toISOString()
    });
  }
}

/** fs backend that delegates reads/writes to the connected editor via {@link DelegationService}. */
export function createRemoteFsBackend(delegation: DelegationService, sessionId: SessionId): FsBackend {
  return {
    delegated: true,
    async readTextFile(path, opts) {
      const result = (await delegation.requestFs(sessionId, {
        op: 'read',
        path,
        offset: opts?.offset,
        limit: opts?.limit
      })) as { content?: string };
      return result.content ?? '';
    },
    async writeTextFile(path, content) {
      const result = (await delegation.requestFs(sessionId, { op: 'write', path, content })) as {
        path?: string;
        bytesWritten?: number;
      };
      return { path: result.path ?? path, bytesWritten: result.bytesWritten ?? Buffer.byteLength(content, 'utf8') };
    }
  };
}

/** terminal backend that delegates command execution to the connected editor. */
export function createRemoteTerminalBackend(delegation: DelegationService, sessionId: SessionId): TerminalBackend {
  return {
    delegated: true,
    exec({ command, cwd, timeoutMs, onChunk }) {
      return delegation.requestTerminal(sessionId, { command, cwd, timeoutMs }, onChunk);
    }
  };
}
