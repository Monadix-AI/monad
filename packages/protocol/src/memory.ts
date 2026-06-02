// Layered-memory contracts. Scope-isolated objective facts (L1): the always-injected core +
// the machine-written recall corpus. L2 (graph) / L3 (laws) are designed but not built; only the
// L1 wire/domain types live here. `org` scope is reserved for a future paid tier (one monad
// instance = one user, so `global` = that user). See docs/memory-design.md.

import type { AgentId, SessionId } from './ids.ts';

import { z } from 'zod';

import { agentIdSchema, iso8601Schema, sessionIdSchema } from './ids.ts';

export const scopeKindSchema = z.enum(['session', 'agent', 'global']); // 'org' reserved (future tier)
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
// their containment: prefixed Crockford base32 is a safe single path segment, so a crafted id can
// never traverse the on-disk memory root. MemoryDir re-checks this as a defense-in-depth backstop.
const scopeIdSchema = z.union([agentIdSchema, sessionIdSchema, z.literal('*')]);

// Shared wire scope selector; the fact/core request DTOs derive from it via `.extend()`.
export const memoryScopeQuerySchema = z.object({
  scopeKind: scopeKindSchema,
  scopeId: scopeIdSchema
});
export type MemoryScopeQuery = z.infer<typeof memoryScopeQuerySchema>;

export const listMemoryFactsResponseSchema = z.object({ facts: z.array(factSchema) });
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

export const editMemoryFactRequestSchema = memoryScopeQuerySchema.extend({
  id: z.string(),
  content: z.string().min(1)
});
export type EditMemoryFactRequest = z.infer<typeof editMemoryFactRequestSchema>;

export const forgetMemoryFactRequestSchema = memoryScopeQuerySchema.extend({ id: z.string() });
export type ForgetMemoryFactRequest = z.infer<typeof forgetMemoryFactRequestSchema>;

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
  qdrant: z.object({ phase: qdrantPhaseSchema, error: z.string().nullable() }).optional()
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
