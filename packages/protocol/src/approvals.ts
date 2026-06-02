// Approval policy: three-state decisions (allow/deny, with `ask` as the no-rule default) across
// tiered scopes (once/session/agent/global). The engine evaluates deny → allow → ask, so a deny
// anywhere always wins (a runtime allow can never override an operator deny). Persisted rules
// (agent + global) live in ~/.monad/approvals.json; session rules are in-memory; operator static
// policy comes from config.json. This file is the single source of truth for the wire/disk shapes.

import { z } from 'zod';

/** A rule decides allow or deny. `ask` is not a rule — it's the default when nothing matches. */
export const approvalDecisionSchema = z.enum(['allow', 'deny']);
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

/** Full scope set used on the wire when a client answers an approval. `once` never persists. */
export const approvalScopeSchema = z.enum(['once', 'session', 'agent', 'global']);
export type ApprovalScope = z.infer<typeof approvalScopeSchema>;

/** Scopes that produce a stored rule (`once` is excluded — it resolves a single call only). */
export const persistedApprovalScopeSchema = z.enum(['session', 'agent', 'global']);
export type PersistedApprovalScope = z.infer<typeof persistedApprovalScopeSchema>;

export const approvalRuleSchema = z.object({
  id: z.string(),
  /** Tool name, e.g. 'shell_exec' / 'code_execute'. */
  tool: z.string(),
  /** Optional pattern key (Tool.gateKey output) narrowing the rule; absent = whole tool. */
  key: z.string().optional(),
  decision: approvalDecisionSchema,
  scope: persistedApprovalScopeSchema,
  /** Required when scope==='agent': the bound agent identity (session.agentIds[0]). */
  agentId: z.string().optional(),
  /** Set when scope==='session': the session the rule is confined to. */
  sessionId: z.string().optional(),
  createdAt: z.string(),
  /** 'operator' = static config.json policy (immutable, deny-wins); 'runtime' = accumulated. */
  source: z.enum(['operator', 'runtime'])
});
export type ApprovalRule = z.infer<typeof approvalRuleSchema>;

/** On-disk shape of ~/.monad/approvals.json. Corrupt/unparseable → treated as empty (fail-closed). */
export const approvalsFileSchema = z.object({
  version: z.literal(1),
  global: z.array(approvalRuleSchema).default([]),
  agents: z.record(z.string(), z.array(approvalRuleSchema)).default({})
});
export type ApprovalsFile = z.infer<typeof approvalsFileSchema>;

/** Optional session filter so a client can also see the current session's in-memory rules. */
export const listApprovalsQuerySchema = z.object({ sessionId: z.string().optional() });
export type ListApprovalsQuery = z.infer<typeof listApprovalsQuerySchema>;

export const listApprovalsResponseSchema = z.object({ rules: z.array(approvalRuleSchema) });
export type ListApprovalsResponse = z.infer<typeof listApprovalsResponseSchema>;

export const revokeApprovalRequestSchema = z.object({ id: z.string() });
export type RevokeApprovalRequest = z.infer<typeof revokeApprovalRequestSchema>;

export const clearApprovalsRequestSchema = z.object({
  scope: persistedApprovalScopeSchema.optional(),
  agentId: z.string().optional()
});
export type ClearApprovalsRequest = z.infer<typeof clearApprovalsRequestSchema>;

export const approvalMutationResponseSchema = z.object({ ok: z.boolean(), removed: z.number().optional() });
export type ApprovalMutationResponse = z.infer<typeof approvalMutationResponseSchema>;
