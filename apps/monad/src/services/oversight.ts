// This is the one genuinely bidirectional flow in the daemon: a server-initiated request
// the client must answer. We model it as an out-of-band event + an inbound RPC rather
// than full reverse-RPC over WS (see transport notes).

import type { ApprovalScope, Event, EventPayloadInput, SessionId } from '@monad/protocol';
import type { ToolGate, ToolGateOutcome, ToolGateRequest } from '#/capabilities/tools/types.ts';

import { newId, resourceApprovalPayloadSchema, sessionIdSchema } from '@monad/protocol';

import { HostEscapePersistError, type PolicyEngine } from '#/agent/approvals/engine.ts';
import { makeEvent } from '#/services/event-bus.ts';

interface Pending {
  resolve: (outcome: ToolGateOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  sessionId: SessionId;
  tool: string;
  key?: string;
  defaultScope?: ApprovalScope;
  rememberScopes?: ApprovalScope[];
}

export interface OversightOptions {
  /** Persist + fan out an event (main.ts injects store.appendEvents + bus.publish). */
  publish: (event: Event) => void;
  /** Approval policy engine — decides allow/deny/ask and stores remembered rules. Omitted →
   *  every high-risk call falls through to a human prompt (today's behaviour, no memory). */
  engine?: PolicyEngine;
  /** Resolve a session's bound agent identity (session.agentIds[0]) for agent-scoped rules. */
  originOf?: (sessionId: string) => string | null;
  /** Auto-deny a request with no response after this long. Default 120_000ms. */
  timeoutMs?: number;
  /** Cap on concurrent pending approvals — beyond it new high-risk calls are denied. Default 100. */
  maxPending?: number;
}

export class OversightService {
  private readonly pending = new Map<string, Pending>();
  private readonly publish: (event: Event) => void;
  private readonly engine?: PolicyEngine;
  private readonly originOf: (sessionId: string) => string | null;
  private readonly timeoutMs: number;
  private readonly maxPending: number;

  constructor(opts: OversightOptions) {
    this.publish = opts.publish;
    this.engine = opts.engine;
    this.originOf = opts.originOf ?? (() => null);
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.maxPending = opts.maxPending ?? 100;
  }

  readonly gate: ToolGate = (req: ToolGateRequest) =>
    new Promise<ToolGateOutcome>((resolve) => {
      // Consult remembered rules first: a matching allow resolves silently (no prompt), a matching
      // deny refuses immediately. Only an `ask` (no rule) falls through to the human prompt.
      const decision =
        this.engine?.decide({
          tool: req.tool,
          key: req.key,
          sessionId: req.sessionId,
          agentId: this.originOf(req.sessionId)
        }) ?? 'ask';
      if (decision === 'allow') {
        resolve({ allow: true });
        return;
      }
      if (decision === 'deny') {
        resolve({ allow: false, reason: 'denied by approval policy' });
        return;
      }
      // Bound the pending registry — a flood of high-risk calls must not accumulate
      // unbounded timers/promises. Over the cap, deny fail-closed (no entry created).
      if (this.pending.size >= this.maxPending) {
        resolve({ allow: false, reason: 'too many pending approvals' });
        return;
      }
      const requestId = newId('gate');
      const sessionId = sessionIdSchema.parse(req.sessionId);
      const timer = setTimeout(() => {
        if (this.pending.delete(requestId)) {
          this.emit(sessionId, 'tool.approval_resolved', {
            requestId,
            tool: req.tool,
            allow: false,
            reason: 'timeout'
          });
          resolve({ allow: false, reason: 'approval request timed out' });
        }
      }, this.timeoutMs);
      const resourceApproval = resourceApprovalPayloadSchema.safeParse(req.input);
      this.pending.set(requestId, {
        resolve,
        timer,
        sessionId,
        tool: req.tool,
        key: req.key,
        ...(resourceApproval.success
          ? {
              defaultScope: resourceApproval.data.defaultScope,
              rememberScopes: resourceApproval.data.rememberScopes
            }
          : {})
      });
      this.emit(sessionId, 'tool.approval_requested', {
        requestId,
        tool: req.tool,
        input: req.input,
        ...(req.key ? { key: req.key } : {})
      });
    });

  /** Cancel all pending approvals for a session (e.g. on abort or delete). Also drops the session's
   *  in-memory approval rules — they must not outlive the session. */
  cancelSession(sessionId: SessionId, reason = 'session_aborted'): void {
    for (const [requestId, p] of this.pending) {
      if (p.sessionId !== sessionId) continue;
      clearTimeout(p.timer);
      this.pending.delete(requestId);
      this.emit(p.sessionId, 'tool.approval_resolved', { requestId, tool: p.tool, allow: false, reason });
      p.resolve({ allow: false, reason });
    }
    this.engine?.clearSession(sessionId);
  }

  /** Resolve a pending request. Returns false if the id is unknown or already resolved. When
   *  `scope` is a persistent/session scope, also remembers the (tool,key) decision so the same call
   *  is not re-prompted. A forbidden host-escape persistence silently downgrades to session scope. */
  async respond(requestId: string, allow: boolean, reason?: string, scope?: ApprovalScope): Promise<boolean> {
    const p = this.pending.get(requestId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    if (scope && p.rememberScopes && !p.rememberScopes.includes(scope)) {
      scope = p.defaultScope && p.rememberScopes.includes(p.defaultScope) ? p.defaultScope : 'once';
    }
    if (scope && scope !== 'once' && this.engine && p.sessionId.startsWith('ses_')) {
      const agentId = this.originOf(p.sessionId);
      try {
        await this.engine.record({
          tool: p.tool,
          key: p.key,
          decision: allow ? 'allow' : 'deny',
          scope,
          sessionId: p.sessionId,
          agentId
        });
      } catch (err) {
        // Host-escape allow can't persist beyond a session — downgrade rather than fail the call.
        if (err instanceof HostEscapePersistError) {
          await this.engine.record({
            tool: p.tool,
            key: p.key,
            decision: 'allow',
            scope: 'session',
            sessionId: p.sessionId,
            agentId
          });
          scope = 'session';
        } else {
          throw err;
        }
      }
    }
    this.emit(p.sessionId, 'tool.approval_resolved', {
      requestId,
      tool: p.tool,
      allow,
      reason,
      scope: scope ?? 'once'
    });
    p.resolve(allow ? { allow: true } : { allow: false, reason: reason ?? 'denied by operator' });
    return true;
  }

  /** List remembered rules: all persisted plus the given session's in-memory rules. */
  listApprovals(sessionId?: string) {
    return this.engine?.list(sessionId) ?? [];
  }

  /** Revoke a single remembered rule by id. */
  revokeApproval(id: string): Promise<boolean> {
    return this.engine?.revoke(id) ?? Promise.resolve(false);
  }

  /** Bulk-clear remembered rules by optional scope/agent filter. Returns the count removed. */
  clearApprovals(filter: { scope?: 'session' | 'agent' | 'global'; agentId?: string } = {}): Promise<number> {
    return this.engine?.clear(filter) ?? Promise.resolve(0);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  listPendingRequests(sessionId?: string): Array<{ id: string; sessionId: string; summary: string }> {
    return [...this.pending.entries()].flatMap(([id, pending]) => {
      if (sessionId && pending.sessionId !== sessionId) return [];
      return [{ id, sessionId: pending.sessionId, summary: pending.tool }];
    });
  }

  private emit<T extends 'tool.approval_requested' | 'tool.approval_resolved'>(
    sessionId: SessionId,
    type: T,
    payload: EventPayloadInput<T>
  ): void {
    this.publish(makeEvent(sessionId, type, payload));
  }
}
