import type { SessionOrigin } from '@monad/protocol';
import type { ToolGate } from '#/capabilities/tools/types.ts';
import type { Store } from '#/store/db/index.ts';

export type InboundApprovalMode = 'auto' | 'local' | 'deny';

// Origin `client` values that follow the inbound-delegation approval policy (which can `auto`-allow
// high-risk tools). This is ONLY for SAME-OWNER delegation — peer federation over OpenAI-compat,
// where the caller already gated the delegation once, so auto-allowing is safe.
//
// Monadix (`client: 'monadix'`) is deliberately NOT here: it is a CROSS-OWNER network (a stranger's
// agent dispatched the task), so its high-risk tools must NOT inherit the same-owner `auto` policy.
// Omitting it routes those tools to the real oversight gate instead — a connected client approves,
// or a headless provider fails closed (deny on timeout). A dedicated cross-owner policy knob can be
// added later; the safe default is full oversight.
const INBOUND_DELEGATION_CLIENTS = new Set<string>(['openai-compat']);

/** Whether a session originated from an inbound delegation (and thus follows the approval policy). */
export function isInboundDelegationSession(origin: SessionOrigin | null | undefined): boolean {
  return origin != null && INBOUND_DELEGATION_CLIENTS.has(origin.client);
}

/**
 * Wrap the oversight gate so high-risk tools in an inbound (peer-delegated) session follow the
 * configured policy instead of hanging — the OpenAI-compat HTTP response has no interactive approval
 * channel, so a delegated run cannot forward an approval back to the caller (that arrives with the
 * PeerLink transport). `auto` allows (same-owner: the caller already gated the delegation once);
 * `deny` rejects; `local` falls through to the real gate so this daemon's own clients can decide.
 * Non-delegation sessions (the daemon's own clients) always go straight to the fallback gate.
 */
export function createInboundApprovalGate(deps: {
  store: Pick<Store, 'getSession'>;
  mode: () => InboundApprovalMode;
  fallback: ToolGate;
}): ToolGate {
  return async (req) => {
    if (req.highRisk && isInboundDelegationSession(deps.store.getSession(req.sessionId)?.origin)) {
      const mode = deps.mode();
      if (mode === 'auto') return { allow: true };
      if (mode === 'deny') return { allow: false, reason: 'inbound delegation policy denies high-risk tools' };
      // 'local' → fall through to the oversight gate (this daemon's own clients approve).
    }
    return deps.fallback(req);
  };
}
