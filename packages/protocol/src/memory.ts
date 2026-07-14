// Layered-memory contracts: the L1 fact/scope domain types plus the memory control-API shapes
// (status, settings, laws). L2 (graph) / L3 (laws) storage lives daemon-side in the graph DB.
// `org` scope is reserved for a future paid tier (one monad instance = one user, so `global` =
// that user). See docs/internals/memory.md.

import type { AgentId, SessionId } from './ids.ts';

import { z } from 'zod';

import { agentIdSchema, iso8601Schema, sessionIdSchema } from './ids.ts';
import { cursorPaginationQuerySchema, cursorPaginationResponseSchema } from './pagination.ts';

export const scopeKindSchema = z.enum(['session', 'agent', 'project', 'global']); // 'org' reserved (future tier)
export type ScopeKind = z.infer<typeof scopeKindSchema>;

// id = sessionId | agentId | '*' (global). One record's isolation key.
export const memoryScopeSchema = z.object({ kind: scopeKindSchema, id: z.string() });
export type MemoryScope = z.infer<typeof memoryScopeSchema>;

// Provenance class: a user-stated fact outranks a machine-extracted one (conflict rule §2.2).
export const provClassSchema = z.enum(['user', 'machine']);
export type ProvClass = z.infer<typeof provClassSchema>;

export const factSchema = z.object({
  // Stable identity in the MD world = hash of the trimmed content (no durable event id).
  id: z.string(),
  content: z.string(),
  scope: memoryScopeSchema,
  provClass: provClassSchema,
  confidence: z.number().min(0).max(1).optional(),
  ts: iso8601Schema.optional()
});
export type Fact = z.infer<typeof factSchema>;

// Per-layer token caps for prompt assembly (§6.1). graph/laws are 0 until Advanced Mode ships.
export interface RecallBudget {
  facts: number;
  graph: number;
  laws: number;
}

export interface RecallCtx {
  query: string;
  sessionId: SessionId;
  agentId: AgentId;
  /** Scopes to recall across (e.g. global + this agent + this workspace), highest-priority first. */
  scopes: MemoryScope[];
  advanced: boolean; // L2+L3 toggle; false in P0
  budget: RecallBudget;
}

// The write target for a turn's facts. Explicit in the signature, never inferred.
export interface WriteCtx {
  sessionId: SessionId;
  scope: MemoryScope;
}

// The assembled block injected into the prompt. graph/laws omitted until Advanced Mode. (Static
// identity — SOUL/AGENT/USER — is injected separately; this block is just the recalled facts.)
export interface MemoryBlock {
  facts: Fact[]; // L1.2 recalled corpus
  tokens: number;
}

// Backend capability negotiation (§3.5). vectorSearch picks semantic vs keyword recall;
// drain feeds L2 (future).
export const l1CapabilitiesSchema = z.object({
  provenance: z.boolean(),
  vectorSearch: z.boolean(),
  inferredWrite: z.boolean(),
  history: z.boolean(),
  prefetch: z.boolean()
});
export type L1Capabilities = z.infer<typeof l1CapabilitiesSchema>;

// Setup-wizard field descriptor a swappable backend advertises (mirrors Hermes get_config_schema).
export const memoryConfigFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  secret: z.boolean().default(false),
  required: z.boolean().default(false),
  envVar: z.string().optional(),
  default: z.string().optional(),
  description: z.string().optional()
});
export type MemoryConfigField = z.infer<typeof memoryConfigFieldSchema>;

// ───────────────────────── wire DTOs (control API §11.2, L1 slice) ─────────────────────────

// A wire scope id is a real agent/session id or the global sentinel `*`. Derived from the canonical
// id schemas (not a hand-rolled charset) so it stays in lockstep with the id format and inherits
// their containment: prefixed alphanumeric nanoid is a safe single path segment, so a crafted id can
// never traverse the on-disk memory root. MemoryDir re-checks this as a defense-in-depth backstop.
const scopeIdSchema = z.union([agentIdSchema, sessionIdSchema, z.literal('*')]);

// Shared wire scope selector; the fact/core request DTOs derive from it via `.extend()`.
export const memoryScopeQuerySchema = z.object({
  scopeKind: scopeKindSchema,
  scopeId: scopeIdSchema
});
export type MemoryScopeQuery = z.infer<typeof memoryScopeQuerySchema>;

// Cursor-paginated: facts can accumulate over the life of a long-running daemon. `before` is a
// fact id (facts are listed in a stable, deterministic order — see the daemon handler).
export const listMemoryFactsQuerySchema = memoryScopeQuerySchema.extend(cursorPaginationQuerySchema.shape);
export type ListMemoryFactsQuery = z.infer<typeof listMemoryFactsQuerySchema>;

export const listMemoryFactsResponseSchema = cursorPaginationResponseSchema.extend({
  facts: z.array(factSchema)
});
export type ListMemoryFactsResponse = z.infer<typeof listMemoryFactsResponseSchema>;

export const memoryCoreResponseSchema = z.object({
  scope: memoryScopeSchema,
  core: z.string() // raw MEMORY.md text for the scope
});
export type MemoryCoreResponse = z.infer<typeof memoryCoreResponseSchema>;

export const putMemoryCoreRequestSchema = memoryScopeQuerySchema.extend({ core: z.string() });
export type PutMemoryCoreRequest = z.infer<typeof putMemoryCoreRequestSchema>;

export const addMemoryFactRequestSchema = memoryScopeQuerySchema.extend({ content: z.string().min(1) });
export type AddMemoryFactRequest = z.infer<typeof addMemoryFactRequestSchema>;

// `id` travels in the URL path (`PATCH /memory/facts/:id`); the body carries only the patch
// fields. `editMemoryFactRequestSchema` is the full logical request (path + body) per
// docs/engineering/conventions.md §5 — the HTTP body schema derives from it via `.omit()`.
export const editMemoryFactRequestSchema = memoryScopeQuerySchema.extend({
  id: z.string(),
  content: z.string().min(1)
});
export type EditMemoryFactRequest = z.infer<typeof editMemoryFactRequestSchema>;

export const editMemoryFactParamsSchema = z.object({ id: z.string() });
export type EditMemoryFactParams = z.infer<typeof editMemoryFactParamsSchema>;

export const editMemoryFactBodySchema = editMemoryFactRequestSchema.omit({ id: true });
export type EditMemoryFactBody = z.infer<typeof editMemoryFactBodySchema>;

// `id` travels in the URL path (`DELETE /memory/facts/:id`); the body carries the remaining scope
// selector only.
export const forgetMemoryFactRequestSchema = memoryScopeQuerySchema.extend({ id: z.string() });
export type ForgetMemoryFactRequest = z.infer<typeof forgetMemoryFactRequestSchema>;

export const forgetMemoryFactParamsSchema = z.object({ id: z.string() });
export type ForgetMemoryFactParams = z.infer<typeof forgetMemoryFactParamsSchema>;

export const forgetMemoryFactBodySchema = forgetMemoryFactRequestSchema.omit({ id: true });
export type ForgetMemoryFactBody = z.infer<typeof forgetMemoryFactBodySchema>;

export const memoryFactResponseSchema = z.object({ fact: factSchema });
export type MemoryFactResponse = z.infer<typeof memoryFactResponseSchema>;

// Active backend selection (single, mutually-exclusive). 'mem0' uses cloud extraction.
export const memoryBackendSchema = z.enum(['builtin', 'mem0']);
export type MemoryBackendId = z.infer<typeof memoryBackendSchema>;

export const qdrantPhaseSchema = z.enum(['idle', 'downloading', 'launching', 'ready', 'failed']);
export type QdrantPhase = z.infer<typeof qdrantPhaseSchema>;

export const memoryStatusResponseSchema = z.object({
  backend: memoryBackendSchema,
  // mem0's resolved model selection (chosen from Monad's model registry). `ready` ⇒ fully resolved.
  mem0: z.object({
    llm: z.string().nullable(),
    embedder: z.string().nullable(),
    embedDim: z.number().nullable(),
    ready: z.boolean(),
    error: z.string().nullable()
  }),
  // Local qdrant lifecycle state. Present when backend='mem0' and no explicit vectorStore override.
  qdrant: z.object({ phase: qdrantPhaseSchema, error: z.string().nullable() }).optional(),
  // How deep the consolidation pipeline runs: 1 = facts only, 2 = + graph, 3 = + inferred laws.
  level: z.number().int().min(1).max(3),
  // Workspaces that have memory (distinct session cwds): the project scope key + its path, so the UI
  // can offer a project picker without the user knowing the hashed key.
  projects: z.array(z.object({ key: z.string(), path: z.string() })),
  // L2 knowledge-graph consolidation settings (off by default). null ⇒ unset (uses the defaults:
  // autoConsolidate off, interval 30m). Lives under `memory.graph` in profile.json.
  graph: z.object({
    autoConsolidate: z.boolean().nullable(),
    intervalMinutes: z.number().nullable()
  })
});
export type MemoryStatusResponse = z.infer<typeof memoryStatusResponseSchema>;

export const setMemoryBackendRequestSchema = z.object({ backend: memoryBackendSchema });
export type SetMemoryBackendRequest = z.infer<typeof setMemoryBackendRequestSchema>;

// Pick mem0's LLM/embedder by Monad profile alias (or providerId:modelId). null clears the override
// (falls back to the default profile / its embedding role); undefined leaves the field unchanged.
export const setMem0ModelsRequestSchema = z.object({
  llm: z.string().nullish(),
  embedder: z.string().nullish(),
  embedDim: z.number().int().positive().nullish()
});
export type SetMem0ModelsRequest = z.infer<typeof setMem0ModelsRequestSchema>;

// Memory consolidation settings. `level` sets the pipeline depth (1-3); `autoConsolidate`/
// `intervalMinutes` gate the background timer. null clears an override (back to defaults); undefined
// leaves the field unchanged. Persisted to `memory.level` / `memory.graph` (hot-applied by the timer).
export const setMemoryGraphRequestSchema = z.object({
  level: z.number().int().min(1).max(3).nullish(),
  autoConsolidate: z.boolean().nullish(),
  intervalMinutes: z.number().int().positive().nullish()
});
export type SetMemoryGraphRequest = z.infer<typeof setMemoryGraphRequestSchema>;

// What an L3 law is grounded in: the L1 facts and L2 graph relations it generalizes (the daemon
// resolves the law's stored id refs into these at read time — the "why do you believe X" provenance).
export const lawGroundingSchema = z.object({
  facts: z.array(z.object({ id: z.string(), content: z.string() })),
  edges: z.array(z.object({ id: z.string(), label: z.string() }))
});
export type LawGrounding = z.infer<typeof lawGroundingSchema>;

// Wire view of an L3 inferred law for the read-only Memory panel. The daemon flattens its SQLite
// store into these (all scopes); the UI groups them by scope and expands grounding on demand.
export const lawViewSchema = z.object({
  id: z.string(),
  scope: z.string(),
  statement: z.string(),
  /** Confidence at derivation (peak). */
  confidence: z.number(),
  /** Confidence after time-decay since `updatedAt` — what recall actually weighs. */
  effectiveConfidence: z.number(),
  /** Invalidated: the law had grounding refs but none resolve any more (its facts/edges are gone). */
  stale: z.boolean(),
  /** The text of a current fact that contradicts this law, or null. Such a law is suppressed from
   *  recall; the UI flags it so the user can re-derive (/consolidate) or correct the fact. */
  contradictedBy: z.string().nullable(),
  grounding: lawGroundingSchema,
  updatedAt: z.number()
});
export type LawView = z.infer<typeof lawViewSchema>;

export const getLawsResponseSchema = z.object({ laws: z.array(lawViewSchema) });
export type GetLawsResponse = z.infer<typeof getLawsResponseSchema>;
