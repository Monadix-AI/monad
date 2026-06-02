// The approval policy engine: aggregates rules from every scope (operator static, global, agent,
// session) and decides allow / deny / ask with deny → allow → ask precedence. A deny anywhere wins,
// so a runtime allow can never override an operator deny. Session rules are held in memory here;
// agent + global persist through ApprovalStore.

import type { ApprovalDecision, ApprovalRule, PersistedApprovalScope } from '@monad/protocol';
import type { ApprovalStore } from './store.ts';

import { newId } from '@monad/protocol';

export interface ApprovalQuery {
  tool: string;
  key?: string;
}

// Gate key marking a host-escape action that drives the user's REAL machine (the computer-use
// server's mutating mouse/keyboard actions). Distinct from code_execute's `target:host` because it
// is a CLASS: a computer-use session emits many differently-named tools (click/type/scroll/…), and
// "let the agent control this computer for this session" must be ONE grant covering all of them,
// not a per-tool prompt. So a host-control rule matches by key alone, across tool names.
export const HOST_CONTROL_KEY = 'host-control';

/** True when this gate request escapes containment to act on the host: arbitrary host code
 *  execution, or driving the real desktop. These share one rule: deny may persist anywhere and an
 *  allow is capped at session scope (never a permanent global/agent "always allow"). */
export function isHostEscape(tool: string, key: string | undefined): boolean {
  return key === HOST_CONTROL_KEY || (tool === 'code_execute' && key === 'target:host');
}

/** A rule matches when the tool is equal AND either the rule is whole-tool (no key) or keys match.
 *  Host-control is the exception: such a rule matches ANY host-control request regardless of tool
 *  name, so one session grant (or one operator deny) covers every desktop-control action. */
export function ruleMatches(rule: ApprovalRule, q: ApprovalQuery): boolean {
  if (rule.key === HOST_CONTROL_KEY) return q.key === HOST_CONTROL_KEY;
  if (rule.tool !== q.tool) return false;
  if (rule.key === undefined) return true;
  return rule.key === q.key;
}

/** Pure decision over a flat rule set: deny wins, then allow, else ask. */
export function decideFromRules(q: ApprovalQuery, rules: readonly ApprovalRule[]): ApprovalDecision | 'ask' {
  const hits = rules.filter((r) => ruleMatches(r, q));
  if (hits.some((r) => r.decision === 'deny')) return 'deny';
  if (hits.some((r) => r.decision === 'allow')) return 'allow';
  return 'ask';
}

/** Parse an operator config entry (`tool` or `tool:key`) into tool + optional key. The key may
 *  itself contain colons (e.g. code_execute:target:host), so split on the FIRST colon only. */
export function parseOperatorEntry(entry: string): { tool: string; key?: string } {
  const idx = entry.indexOf(':');
  if (idx === -1) return { tool: entry };
  return { tool: entry.slice(0, idx), key: entry.slice(idx + 1) || undefined };
}

/** Build immutable operator rules from config's agent.approvals lists. `ask` entries are the
 *  default and carry no decision, so only deny + allow become rules. */
export function buildOperatorRules(approvals: { deny: string[]; allow: string[] }): ApprovalRule[] {
  const mk = (entry: string, decision: ApprovalDecision): ApprovalRule => {
    const { tool, key } = parseOperatorEntry(entry);
    return {
      id: `operator:${decision}:${entry}`,
      tool,
      key,
      decision,
      scope: 'global',
      createdAt: new Date(0).toISOString(),
      source: 'operator'
    };
  };
  return [...approvals.deny.map((e) => mk(e, 'deny')), ...approvals.allow.map((e) => mk(e, 'allow'))];
}

/** Thrown when a caller tries to persist a host-escape allow beyond a single session. */
export class HostEscapePersistError extends Error {
  constructor() {
    super('host-escape allow (host code execution / desktop control) cannot persist beyond session scope');
    this.name = 'HostEscapePersistError';
  }
}

/** A persistent allow for a host escape is forbidden — one click must not grant permanent arbitrary
 *  host code execution or standing control of the user's desktop. Deny may always persist; a
 *  session allow is fine (it expires with the session). */
function isForbiddenHostEscape(rule: {
  tool: string;
  key?: string;
  decision: ApprovalDecision;
  scope: PersistedApprovalScope;
}): boolean {
  return isHostEscape(rule.tool, rule.key) && rule.decision === 'allow' && rule.scope !== 'session';
}

export interface RecordInput {
  tool: string;
  key?: string;
  decision: ApprovalDecision;
  scope: PersistedApprovalScope;
  sessionId: string;
  agentId: string | null;
}

export class PolicyEngine {
  private readonly sessionRules = new Map<string, ApprovalRule[]>();

  constructor(
    private readonly store: ApprovalStore,
    private readonly operatorRules: () => readonly ApprovalRule[]
  ) {}

  /** Decide for a gate request, aggregating every applicable scope. */
  decide(req: { tool: string; key?: string; sessionId: string; agentId: string | null }): ApprovalDecision | 'ask' {
    const rules: ApprovalRule[] = [
      ...this.operatorRules(),
      ...this.store.global(),
      ...(req.agentId ? this.store.forAgent(req.agentId) : []),
      ...(this.sessionRules.get(req.sessionId) ?? [])
    ];
    return decideFromRules(req, rules);
  }

  /** Persist a new rule for the given scope. Throws HostEscapePersistError when a host-escape allow
   *  is requested beyond session scope (caller decides whether to downgrade or surface). */
  async record(input: RecordInput): Promise<ApprovalRule> {
    if (isForbiddenHostEscape(input)) throw new HostEscapePersistError();
    const rule: ApprovalRule = {
      id: newId('apr'),
      tool: input.tool,
      key: input.key,
      decision: input.decision,
      scope: input.scope,
      agentId: input.scope === 'agent' ? (input.agentId ?? undefined) : undefined,
      sessionId: input.scope === 'session' ? input.sessionId : undefined,
      createdAt: new Date().toISOString(),
      source: 'runtime'
    };
    if (rule.scope === 'session') {
      const list = this.sessionRules.get(input.sessionId) ?? [];
      list.push(rule);
      this.sessionRules.set(input.sessionId, list);
    } else {
      await this.store.add(rule);
    }
    return rule;
  }

  /** Drop all in-memory session rules for a session (on abort/delete). */
  clearSession(sessionId: string): void {
    this.sessionRules.delete(sessionId);
  }

  /** List rules: all persisted (global + agents) plus, if given, the session's in-memory rules. */
  list(sessionId?: string): ApprovalRule[] {
    const persisted = this.store.all();
    const session = sessionId ? (this.sessionRules.get(sessionId) ?? []) : [];
    return [...persisted, ...session];
  }

  /** Revoke a rule by id across persisted + session layers. */
  async revoke(id: string): Promise<boolean> {
    let removed = await this.store.remove(id);
    for (const [sid, rules] of this.sessionRules) {
      const filtered = rules.filter((r) => r.id !== id);
      if (filtered.length !== rules.length) {
        removed = true;
        if (filtered.length === 0) this.sessionRules.delete(sid);
        else this.sessionRules.set(sid, filtered);
      }
    }
    return removed;
  }

  /** Bulk-clear persisted rules by optional scope/agent filter. Session rules cleared when no
   *  scope filter or scope==='session'. Returns count removed. */
  async clear(filter: { scope?: PersistedApprovalScope; agentId?: string } = {}): Promise<number> {
    let removed = 0;
    if (!filter.scope || filter.scope === 'session') {
      for (const rules of this.sessionRules.values()) removed += rules.length;
      this.sessionRules.clear();
    }
    if (filter.scope === 'global' || filter.scope === 'agent') {
      removed += await this.store.clear({ scope: filter.scope, agentId: filter.agentId });
    } else if (!filter.scope) {
      removed += await this.store.clear({ agentId: filter.agentId });
    }
    return removed;
  }
}
