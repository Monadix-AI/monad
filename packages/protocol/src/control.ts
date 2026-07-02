// NOT the A2A collaboration protocol (gates/contracts/signed log) — that is deferred.
// Boundary parsing (HTTP wiring) lives in http.ts.

import { z } from 'zod';

import { approvalScopeSchema } from './approvals.ts';
import {
  agentAtomsSchema,
  agentSchema,
  agentVisibilitySchema,
  chatMessageSchema,
  eventSchema,
  modelProfileRoutesSchema,
  modelRoleSchema,
  modelRolesSchema,
  sandboxModeSchema,
  searchHitSchema,
  sessionOriginExtSchema,
  sessionOriginSchema,
  sessionSchema,
  sessionStateSchema,
  sessionSurfaceSchema,
  sessionTransportSchema
} from './domain.ts';
import { agentIdSchema, messageIdSchema, sessionIdSchema, transcriptTargetIdSchema } from './ids.ts';
import { httpsUrlSchema, httpUrlSchema } from './url.ts';

export const CONTROL_API_VERSION = 'v1' as const;

// DoS guard: unbounded strings let a caller exhaust memory with a single request.
export const SESSION_TITLE_MAX = 1_000;
export const MESSAGE_TEXT_MAX = 1_000_000;
export const SEARCH_QUERY_MAX = 1_000;

/**
 * Client-declared origin hints on session create. Only the safe-to-trust identity fields are
 * accepted from the body; the daemon fills `transport` and `env` server-side (never trusting the
 * client for those), and defaults `writableBy` from `surface` unless an explicit override is given.
 */
export const createSessionOriginHintSchema = z.object({
  surface: sessionSurfaceSchema.optional(),
  client: z.string().max(200).optional(),
  clientVersion: z.string().max(100).optional(),
  writableBy: z.array(sessionTransportSchema).optional(),
  branchableBy: z.array(sessionTransportSchema).optional(),
  ext: sessionOriginExtSchema.optional()
});
export type CreateSessionOriginHint = z.infer<typeof createSessionOriginHintSchema>;

export const createSessionRequestSchema = z.object({
  title: z.string().max(SESSION_TITLE_MAX),
  /** Agent to bind to this session. If omitted, the daemon uses agent.defaultAgentId from config. */
  agentId: agentIdSchema.optional(),
  /** Optional client-declared provenance/policy hints (see createSessionOriginHintSchema). */
  origin: createSessionOriginHintSchema.optional(),
  /** Default working directory for shell commands and skill-path matching. Absent → daemon workspace. */
  cwd: z.string().optional()
});
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const createAgentRequestSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(1024).optional(),
  modelAlias: z.string().optional(),
  roles: modelRolesSchema.optional(),
  model: z.string().optional(),
  framework: z.enum(['openclaw', 'hermes', 'manus', 'monad', 'custom']).optional(),
  capabilities: z.array(z.string()).default([]),
  atoms: agentAtomsSchema.optional(),
  sandboxMode: sandboxModeSchema.optional(),
  maxTurns: z.number().int().positive().optional(),
  maxThinkingTokens: z.number().int().positive().optional(),
  maxBudgetUsd: z.number().positive().optional(),
  visibility: agentVisibilitySchema.optional(),
  /** Initial AGENT.md system-prompt body. Absent → no .md written (valid empty-prompt agent). */
  prompt: z.string().optional()
});
export type CreateAgentRequest = z.infer<typeof createAgentRequestSchema>;

/** Partial update — only provided keys change. The prompt body is set via agents.prompt.set. */
export const updateAgentRequestSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(1024).optional(),
  modelAlias: z.string().optional(),
  roles: modelRolesSchema.optional(),
  model: z.string().optional(),
  framework: z.enum(['openclaw', 'hermes', 'manus', 'monad', 'custom']).optional(),
  capabilities: z.array(z.string()).optional(),
  atoms: agentAtomsSchema.optional(),
  sandboxMode: sandboxModeSchema.optional(),
  maxTurns: z.number().int().positive().optional(),
  maxThinkingTokens: z.number().int().positive().optional(),
  maxBudgetUsd: z.number().positive().optional(),
  visibility: agentVisibilitySchema.optional()
});
export type UpdateAgentRequest = z.infer<typeof updateAgentRequestSchema>;

export const getAgentPromptResponseSchema = z.object({ prompt: z.string() });
export type GetAgentPromptResponse = z.infer<typeof getAgentPromptResponseSchema>;

export const setAgentPromptRequestSchema = z.object({ prompt: z.string() });
export type SetAgentPromptRequest = z.infer<typeof setAgentPromptRequestSchema>;

export const createAgentResponseSchema = z.object({ agent: agentSchema });
export type CreateAgentResponse = z.infer<typeof createAgentResponseSchema>;

export const listAgentsResponseSchema = z.object({ agents: z.array(agentSchema) });
export type ListAgentsResponse = z.infer<typeof listAgentsResponseSchema>;

export const getAgentResponseSchema = z.object({ agent: agentSchema });
export type GetAgentResponse = z.infer<typeof getAgentResponseSchema>;

export const setDefaultAgentRequestSchema = z.object({ agentId: agentIdSchema });
export type SetDefaultAgentRequest = z.infer<typeof setDefaultAgentRequestSchema>;

export const getDefaultAgentResponseSchema = z.object({ agentId: agentIdSchema.nullable() });
export type GetDefaultAgentResponse = z.infer<typeof getDefaultAgentResponseSchema>;

export const createSessionResponseSchema = z.object({ sessionId: sessionIdSchema });
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;

export const sendMessageRequestSchema = z.object({
  text: z.string().max(MESSAGE_TEXT_MAX),
  generate: z.boolean().optional(),
  // Optional ambient context for THIS turn (the ACP bridge forwards the editor's open-document
  // snapshot here, since it can't ride in-process runOpts over the wire). Inline-SSE send only.
  ambientContext: z.string().max(MESSAGE_TEXT_MAX).optional()
});
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;

export const sendMessageResponseSchema = z.object({ accepted: z.literal(true) });
export type SendMessageResponse = z.infer<typeof sendMessageResponseSchema>;

export const toolApproveRequestSchema = z.object({
  requestId: z.string(),
  allow: z.boolean(),
  reason: z.string().max(500).optional(),
  // Persistence scope for this decision. Absent or 'once' resolves a single call (today's
  // behaviour); 'session'/'agent'/'global' also stores a rule so the same (tool,key) is not
  // re-prompted. Applies to deny too (deny-always). See ./approvals.ts.
  scope: approvalScopeSchema.optional()
});
export type ToolApproveRequest = z.infer<typeof toolApproveRequestSchema>;

/** `ok:false` → request id unknown or already resolved (e.g. timed out). */
export const toolApproveResponseSchema = z.object({ ok: z.boolean() });
export type ToolApproveResponse = z.infer<typeof toolApproveResponseSchema>;

export const clarifyRespondRequestSchema = z.object({
  requestId: z.string(),
  answer: z.string().max(10_000)
});
export type ClarifyRespondRequest = z.infer<typeof clarifyRespondRequestSchema>;

/** `ok:false` → request id unknown or already resolved (e.g. timed out). */
export const clarifyRespondResponseSchema = z.object({ ok: z.boolean() });
export type ClarifyRespondResponse = z.infer<typeof clarifyRespondResponseSchema>;

export const forwardToAcpRequestSchema = z.object({
  text: z.string().min(1).max(MESSAGE_TEXT_MAX),
  ambientContext: z.string().max(MESSAGE_TEXT_MAX).optional()
});
export type ForwardToAcpRequest = z.infer<typeof forwardToAcpRequestSchema>;

export const forwardToAcpResponseSchema = z.object({ accepted: z.literal(true) });
export type ForwardToAcpResponse = z.infer<typeof forwardToAcpResponseSchema>;

export const generateMessageResponseSchema = z.object({ message: chatMessageSchema });
export type GenerateMessageResponse = z.infer<typeof generateMessageResponseSchema>;

/** Shared query fields for offset-based (page-number) pagination. */
export const offsetPaginationQuerySchema = z.object({
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional()
});
export type OffsetPaginationQuery = z.infer<typeof offsetPaginationQuerySchema>;

/** Shared response envelope fields for offset-based pagination. */
export const offsetPaginationResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  next: httpUrlSchema.optional(),
  previous: httpUrlSchema.optional()
});
export type OffsetPaginationResponse = z.infer<typeof offsetPaginationResponseSchema>;

/** Shared query fields for cursor-based (infinite-load) pagination. */
export const cursorPaginationQuerySchema = z.object({
  limit: z.coerce.number().int().positive().optional(),
  before: z.string().optional()
});
export type CursorPaginationQuery = z.infer<typeof cursorPaginationQuerySchema>;

/** Shared response envelope fields for cursor-based pagination. */
export const cursorPaginationResponseSchema = z.object({
  nextCursor: z.string().optional(),
  next: httpUrlSchema.optional(),
  previous: httpUrlSchema.optional()
});
export type CursorPaginationResponse = z.infer<typeof cursorPaginationResponseSchema>;

export const listSessionsQuerySchema = offsetPaginationQuerySchema.extend({
  archived: z.boolean().optional(),
  state: sessionStateSchema.optional()
});
export type ListSessionsQuery = z.infer<typeof listSessionsQuerySchema>;

export const listSessionsResponseSchema = offsetPaginationResponseSchema.extend({
  sessions: z.array(sessionSchema)
});
export type ListSessionsResponse = z.infer<typeof listSessionsResponseSchema>;

export const getHealthResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  warnings: z.array(z.string()).optional(),
  certFingerprint: z.string().optional(),
  certExpiry: z.string().optional(),
  latestVersion: z.string().optional(),
  latestVersionCheckedAt: z.string().optional()
});
export type GetHealthResponse = z.infer<typeof getHealthResponseSchema>;

/** The operation a ledger row was booked under (orthogonal to the model's kind). */
export const ledgerCategorySchema = z.enum(['chat', 'embedding', 'image', 'speech']);
export type LedgerCategory = z.infer<typeof ledgerCategorySchema>;

/** One row of the global usage ledger (per provider/model), all-cumulative. */
export const ledgerEntrySchema = z.object({
  provider: z.string(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  reasoningTokens: z.number(),
  costUsd: z.number(),
  updatedAt: z.string()
});
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;

/** One fully-dimensioned ledger row (local day × provider × model × category) for the global
 *  multi-dimensional view. `entries` above is this aggregated over day+category. */
export const ledgerBreakdownEntrySchema = ledgerEntrySchema.extend({
  day: z.string(), // local calendar day, YYYY-MM-DD
  category: ledgerCategorySchema
});
export type LedgerBreakdownEntry = z.infer<typeof ledgerBreakdownEntrySchema>;

/** The global usage "账本": cumulative totals + a per-provider/model rollup + the full
 *  day/provider/model/category breakdown for multi-dimensional drill-down. */
export const getUsageResponseSchema = z.object({
  totalCostUsd: z.number(),
  totalInputTokens: z.number(),
  totalOutputTokens: z.number(),
  entries: z.array(ledgerEntrySchema),
  breakdown: z.array(ledgerBreakdownEntrySchema)
});
export type GetUsageResponse = z.infer<typeof getUsageResponseSchema>;

/** Range filter for stats queries. */
export const statsRangeSchema = z.enum(['all', '30d', '7d']);
export type StatsRange = z.infer<typeof statsRangeSchema>;

/** One day bucket in the heat-map / time-series: total tokens produced that local day. */
export const dayBucketSchema = z.object({
  day: z.string(), // YYYY-MM-DD local
  totalTokens: z.number()
});
export type DayBucket = z.infer<typeof dayBucketSchema>;

/** Per-model token share for the Models tab. */
export const modelShareSchema = z.object({
  model: z.string(),
  provider: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  pct: z.number() // 0-100
});
export type ModelShare = z.infer<typeof modelShareSchema>;

/** Overview + Models stats, pre-aggregated on the daemon for all range variants. */
export const getStatsResponseSchema = z.object({
  range: statsRangeSchema,
  sessions: z.number(),
  messages: z.number(),
  totalTokens: z.number(),
  activeDays: z.number(),
  currentStreak: z.number(),
  longestStreak: z.number(),
  peakHour: z.number().nullable(), // 0-23 local hour, null when no data
  favoriteModel: z.string().nullable(),
  heatmap: z.array(dayBucketSchema), // all active days in range, asc; used for both heatmap grid and bar chart
  models: z.array(modelShareSchema)
});
export type GetStatsResponse = z.infer<typeof getStatsResponseSchema>;

export const getSessionResponseSchema = z.object({ session: sessionSchema });
export type GetSessionResponse = z.infer<typeof getSessionResponseSchema>;

/** Git summary of a session's working folder, for the workplace header. `isRepo:false` covers "no
 *  working folder set", "not a git repo", and "git unavailable" — the UI treats all three the same. */
export const workspaceGitSchema = z.object({
  isRepo: z.boolean(),
  branch: z.string().optional(),
  dirty: z.boolean().optional(),
  ahead: z.number().int().optional(),
  behind: z.number().int().optional(),
  remoteUrl: z.string().optional()
});
export type WorkspaceGit = z.infer<typeof workspaceGitSchema>;

export const workspaceMetaSchema = z.object({
  git: workspaceGitSchema
});
export type WorkspaceMeta = z.infer<typeof workspaceMetaSchema>;

export const workspaceActionSchema = z.enum(['show-in-file-manager', 'open-terminal']);
export type WorkspaceAction = z.infer<typeof workspaceActionSchema>;

export const workspaceActionRequestSchema = z.object({
  action: workspaceActionSchema
});
export type WorkspaceActionRequest = z.infer<typeof workspaceActionRequestSchema>;

export const workspaceActionResponseSchema = z.object({
  ok: z.literal(true),
  action: workspaceActionSchema
});
export type WorkspaceActionResponse = z.infer<typeof workspaceActionResponseSchema>;

export const updateSessionRequestSchema = z.object({
  title: z.string().max(SESSION_TITLE_MAX).optional(),
  state: sessionStateSchema.optional(),
  archived: z.boolean().optional(),
  agentId: agentIdSchema.nullable().optional(),
  origin: sessionOriginSchema.nullable().optional(),
  /** Shared working folder for this session — absolute path; empty string clears it. Sets `session.cwd`
   *  and broadens the runtime sandbox to that folder (inherited by delegated subagents). */
  cwd: z.string().optional()
});
export type UpdateSessionRequest = z.infer<typeof updateSessionRequestSchema>;

export const updateSessionResponseSchema = z.object({ session: sessionSchema });
export type UpdateSessionResponse = z.infer<typeof updateSessionResponseSchema>;

export const deleteSessionResponseSchema = z.object({ deleted: z.literal(true) });
export type DeleteSessionResponse = z.infer<typeof deleteSessionResponseSchema>;

export const abortSessionResponseSchema = z.object({ aborted: z.boolean() });
export type AbortSessionResponse = z.infer<typeof abortSessionResponseSchema>;

export const resetSessionResponseSchema = z.object({ clearedCount: z.number() });
export type ResetSessionResponse = z.infer<typeof resetSessionResponseSchema>;

export const listMessagesQuerySchema = cursorPaginationQuerySchema.extend({
  before: messageIdSchema.optional(),
  includeInactive: z.stringbool().optional(),
  includeAncestors: z.stringbool().optional()
});
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;

export const listMessagesResponseSchema = cursorPaginationResponseSchema.extend({
  messages: z.array(chatMessageSchema)
});
export type ListMessagesResponse = z.infer<typeof listMessagesResponseSchema>;

export const branchSessionRequestSchema = z.object({
  title: z.string().max(SESSION_TITLE_MAX).optional(),
  atMessageId: messageIdSchema.optional(),
  /** Provenance hints for the CHILD — stamped from the branching transport (see create). */
  origin: createSessionOriginHintSchema.optional()
});
export type BranchSessionRequest = z.infer<typeof branchSessionRequestSchema>;

export const branchSessionResponseSchema = z.object({ sessionId: sessionIdSchema });
export type BranchSessionResponse = z.infer<typeof branchSessionResponseSchema>;

export const getProvenanceResponseSchema = z.object({
  ancestors: z.array(sessionSchema),
  self: sessionSchema,
  descendants: z.array(sessionSchema)
});
export type GetProvenanceResponse = z.infer<typeof getProvenanceResponseSchema>;

export const restoreSessionRequestSchema = z.object({ toMessageId: messageIdSchema });
export type RestoreSessionRequest = z.infer<typeof restoreSessionRequestSchema>;

export const restoreSessionResponseSchema = z.object({
  restoredCount: z.number(),
  newHeadMessageId: messageIdSchema.nullable()
});
export type RestoreSessionResponse = z.infer<typeof restoreSessionResponseSchema>;

// A client-provided MCP server the daemon should connect for the session (subset of the daemon's built-in tools'
// McpServerSpec that's serialisable — no dynamic `auth` callback; ACP clients carry static headers).
const sessionMcpStdioSchema = z.object({
  name: z.string(),
  transport: z.literal('stdio').optional(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  requestTimeoutMs: z.number().optional()
});
const sessionMcpHttpSchema = z.object({
  name: z.string(),
  transport: z.literal('http'),
  url: httpUrlSchema,
  headers: z.record(z.string(), z.string()).optional(),
  requestTimeoutMs: z.number().optional()
});
export const sessionMcpServerSchema = z.union([sessionMcpHttpSchema, sessionMcpStdioSchema]);
export type SessionMcpServer = z.infer<typeof sessionMcpServerSchema>;

// Per-session runtime config the ACP bridge pushes to the shared daemon: the editor's project dir
// becomes the session's sandbox roots, and the editor's MCP servers connect daemon-side (their tools
// added to every turn). Distinct from origin (identity/policy) — this is execution config.
export const configureRuntimeRequestSchema = z.object({
  sandboxRoots: z.array(z.string()).optional(),
  mcpServers: z.array(sessionMcpServerSchema).optional(),
  // The client advertised fs/terminal capability — the daemon should delegate those ops back to it
  // (editor-side diffs / terminal) via DelegationService instead of running them on the daemon host.
  delegate: z.object({ fs: z.boolean().optional(), terminal: z.boolean().optional() }).optional()
});
export type ConfigureRuntimeRequest = z.infer<typeof configureRuntimeRequestSchema>;

// Reverse-delegation responses (client → daemon), answering a delegation.{fs,terminal}_request event.
export const delegationRespondRequestSchema = z.object({
  requestId: z.string(),
  ok: z.boolean(),
  // fs read → { content }; fs write → { path, bytesWritten }; terminal → TerminalExecResult.
  result: z.unknown().optional(),
  error: z.string().optional()
});
export type DelegationRespondRequest = z.infer<typeof delegationRespondRequestSchema>;

// Incremental terminal output (client → daemon) while a delegated command runs; cumulative text.
export const delegationOutputRequestSchema = z.object({
  requestId: z.string(),
  output: z.string()
});
export type DelegationOutputRequest = z.infer<typeof delegationOutputRequestSchema>;

// ok:false → unknown/expired request id (mirrors tools.approve / clarify.respond).
export const delegationAckResponseSchema = z.object({ ok: z.boolean() });
export type DelegationAckResponse = z.infer<typeof delegationAckResponseSchema>;

export const searchModeSchema = z.enum(['keyword', 'semantic', 'hybrid']);
export type SearchMode = z.infer<typeof searchModeSchema>;

export const searchSessionsRequestSchema = z.object({
  q: z.string().max(SEARCH_QUERY_MAX).optional().default(''),
  mode: searchModeSchema.optional(),
  limit: z.number().int().positive().optional(),
  transcriptTargetId: transcriptTargetIdSchema.optional()
});
export type SearchSessionsRequest = z.infer<typeof searchSessionsRequestSchema>;

export const searchSessionsResponseSchema = z.object({
  hits: z.array(searchHitSchema),
  // Active messages not yet embedded (semantic/hybrid only). >0 ⇒ the background indexer is still
  // catching up and semantic recall may be incomplete; the client can surface an "indexing" hint.
  indexingPending: z.number().optional()
});
export type SearchSessionsResponse = z.infer<typeof searchSessionsResponseSchema>;

// Self-contained view shapes for model settings (gateway), no dependency on @monad/home. Secrets
// never cross this boundary: a CredentialView carries only a short `accessTokenPreview`.

export enum ModelProviderType {
  // Native: a dedicated AI SDK package backs buildModel()
  Anthropic = 'anthropic',
  OpenAI = 'openai',
  VercelGateway = 'vercel-gateway',
  OpenRouter = 'openrouter',
  Google = 'google',
  Mistral = 'mistral',
  AmazonBedrock = 'amazon-bedrock',
  Azure = 'azure',
  // OpenAI-compatible: bundled adapter + a preset base URL
  OpenAICompatible = 'openai-compatible',
  CloudflareGateway = 'cloudflare-gateway',
  Groq = 'groq',
  XAI = 'xai',
  DeepSeek = 'deepseek',
  Together = 'together',
  Fireworks = 'fireworks',
  Cerebras = 'cerebras',
  Perplexity = 'perplexity',
  Moonshot = 'moonshot',
  ZAI = 'zai',
  MiniMax = 'minimax',
  Nvidia = 'nvidia',
  Novita = 'novita',
  Ollama = 'ollama',
  HuggingFace = 'huggingface'
}

export const KNOWN_PROVIDER_TYPES = [
  ModelProviderType.Anthropic,
  ModelProviderType.OpenAI,
  ModelProviderType.VercelGateway,
  ModelProviderType.OpenRouter,
  ModelProviderType.Google,
  ModelProviderType.Mistral,
  ModelProviderType.AmazonBedrock,
  ModelProviderType.Azure,
  ModelProviderType.OpenAICompatible,
  ModelProviderType.CloudflareGateway,
  ModelProviderType.Groq,
  ModelProviderType.XAI,
  ModelProviderType.DeepSeek,
  ModelProviderType.Together,
  ModelProviderType.Fireworks,
  ModelProviderType.Cerebras,
  ModelProviderType.Perplexity,
  ModelProviderType.Moonshot,
  ModelProviderType.ZAI,
  ModelProviderType.MiniMax,
  ModelProviderType.Nvidia,
  ModelProviderType.Novita,
  ModelProviderType.Ollama,
  ModelProviderType.HuggingFace
] as const;

export type ProviderType = `${ModelProviderType}`;

// Single source of truth for the providers monad offers. The web wizard, CLI, and
// agent-core registry all derive from this. `strategy`:
//   'native'            → a dedicated AI SDK package (agent-core bundles it)
//   'openai-compatible' → bundled @ai-sdk/openai-compatible adapter at `defaultBaseUrl`

export type ProviderStrategy = 'native' | 'openai-compatible';

/** An extra config field a provider needs beyond key + base URL (e.g. AWS region).
 *  Persisted into `Provider.extra` and read back in the atom's buildModel(). */
export const providerExtraFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  placeholder: z.string().optional(),
  required: z.boolean().optional()
});
export type ProviderExtraField = z.infer<typeof providerExtraFieldSchema>;

/** Self-describing metadata a `ModelProvider` atom carries. The daemon assembles the provider
 *  catalog (consumed by the UI/CLI) from registered providers' descriptors — the built-in catalog
 *  DATA lives in @monad/atoms, not here; protocol holds only the shape + the known-type enum.
 *  `type` is an open string: a third-party provider atom may introduce a brand-new type. */
export const modelProviderDescriptorSchema = z.object({
  type: z.string(),
  label: z.string(),
  strategy: z.enum(['native', 'openai-compatible']),
  defaultBaseUrl: httpUrlSchema.optional(),
  needsUrl: z.boolean().optional(),
  keyPlaceholder: z.string().optional(),
  npmPackage: z.string().optional(),
  extraFields: z.array(providerExtraFieldSchema).optional(),
  keyOptional: z.boolean().optional()
});
export type ModelProviderDescriptor = z.infer<typeof modelProviderDescriptorSchema>;

export const getProviderCatalogResponseSchema = z.object({ providers: z.array(modelProviderDescriptorSchema) });
export type GetProviderCatalogResponse = z.infer<typeof getProviderCatalogResponseSchema>;

// Parse a provider catalogue's native pricing block ($/token) into the canonical ModelPrice
// (defined below, $/1M). Live here (not agent-core) so both the gateway and the ai-sdk-free
// provider atoms can attach price to a model listing. ModelPrice itself is single-sourced as
// `modelPriceSchema`/`ModelPrice` further down this file.

const PRICE_PER_MILLION = 1_000_000;

function perMillion(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number.parseFloat(v) : typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n * PRICE_PER_MILLION : undefined;
}

function unitPrice(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number.parseFloat(v) : typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function buildPrice(fields: {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  videoSecond?: unknown;
}): ModelPrice | undefined {
  const price: ModelPrice = {};
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
    const v = perMillion(fields[k]);
    if (v !== undefined) price[k] = v;
  }
  const videoSecond = unitPrice(fields.videoSecond);
  if (videoSecond !== undefined) price.videoSecond = videoSecond;
  return Object.keys(price).length > 0 ? price : undefined;
}

function priceUnitMeta(key: string): { label: string; unit: string; multiplier: number } {
  switch (key) {
    case 'prompt':
      return { label: 'Input', unit: 'M', multiplier: PRICE_PER_MILLION };
    case 'completion':
      return { label: 'Output', unit: 'M', multiplier: PRICE_PER_MILLION };
    case 'input_cache_read':
      return { label: 'Cache read', unit: 'M', multiplier: PRICE_PER_MILLION };
    case 'input_cache_write':
      return { label: 'Cache write', unit: 'M', multiplier: PRICE_PER_MILLION };
    case 'video':
    case 'video_second':
    case 'video_per_second':
    case 'per_second':
      return { label: 'Video', unit: 'second', multiplier: 1 };
    case 'per_minute':
      return { label: 'Audio', unit: 'minute', multiplier: 1 };
    case 'per_hour':
      return { label: 'Audio', unit: 'hour', multiplier: 1 };
    case 'image_output':
      // OpenRouter reports image_output per 64x64 tile; normalize to the public $/megapixel unit.
      return { label: 'Image output', unit: 'megapixel', multiplier: 4096 };
    case 'search':
    case 'web_search':
      return { label: 'Search', unit: 'search', multiplier: 1 };
  }
  const normalized = key.replace(/^per_/, '').replace(/_/g, ' ');
  const label = normalized.replace(/\b\w/g, (char) => char.toUpperCase());
  if (key.includes('token')) return { label, unit: 'M', multiplier: PRICE_PER_MILLION };
  if (key.includes('song')) return { label, unit: 'song', multiplier: 1 };
  if (key.includes('second')) return { label, unit: 'second', multiplier: 1 };
  if (key.includes('minute')) return { label, unit: 'minute', multiplier: 1 };
  if (key.includes('image')) return { label, unit: 'image', multiplier: 1 };
  if (key.includes('request')) return { label, unit: 'request', multiplier: 1 };
  if (key.includes('search')) return { label, unit: 'search', multiplier: 1 };
  return { label, unit: 'unit', multiplier: 1 };
}

type ModelPriceUnit = { label: string; price: number; unit: string };

function titleCaseKey(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function openAiPriceUnits(p: Record<string, unknown>): ModelPriceUnit[] {
  return Object.entries(p)
    .flatMap(([key, value]) => {
      const n = typeof value === 'string' ? Number.parseFloat(value) : typeof value === 'number' ? value : Number.NaN;
      if (!Number.isFinite(n) || n <= 0) return [];
      const meta = priceUnitMeta(key);
      return [{ label: meta.label, price: n * meta.multiplier, unit: meta.unit }];
    })
    .filter(
      (item, index, items) =>
        items.findIndex((other) => other.label === item.label && other.unit === item.unit) === index
    );
}

function fieldString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function vercelVideoDurationPriceUnits(value: unknown): ModelPriceUnit[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const record = item as Record<string, unknown>;
      const price = unitPrice(record.cost_per_second);
      if (price === undefined) return [];
      const parts = [
        fieldString(record, 'resolution'),
        fieldString(record, 'mode'),
        typeof record.audio === 'boolean' ? (record.audio ? 'Audio' : 'No audio') : undefined
      ].filter((part): part is string => !!part);
      return [{ label: parts.length > 0 ? parts.join(' ') : 'Video', price, unit: 'second' }];
    })
    .sort((a, b) => a.price - b.price || a.label.localeCompare(b.label))
    .filter(
      (item, index, items) =>
        items.findIndex(
          (other) => other.label === item.label && other.price === item.price && other.unit === item.unit
        ) === index
    );
}

function vercelVideoTokenPriceUnits(value: unknown): ModelPriceUnit[] {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, item]) => {
      if (!item || typeof item !== 'object') return [];
      const price = unitPrice((item as Record<string, unknown>).cost_per_million_tokens);
      if (price === undefined) return [];
      return [{ label: titleCaseKey(key), price, unit: 'M' }];
    })
    .sort((a, b) => a.price - b.price || a.label.localeCompare(b.label));
}

/** OpenAI/OpenRouter-style `/models` pricing block ($/token). */
export function openAiPrice(
  p:
    | {
        [key: string]: unknown;
        prompt?: unknown;
        completion?: unknown;
        input_cache_read?: unknown;
        input_cache_write?: unknown;
        video?: unknown;
        video_second?: unknown;
        video_per_second?: unknown;
        per_second?: unknown;
        per_minute?: unknown;
        per_hour?: unknown;
      }
    | null
    | undefined
): ModelPrice | undefined {
  if (!p) return undefined;
  const price = buildPrice({
    input: p.prompt,
    output: p.completion,
    cacheRead: p.input_cache_read,
    cacheWrite: p.input_cache_write,
    videoSecond: firstDefined(p.video_second, p.video_per_second, p.per_second, p.video)
  });
  const units = openAiPriceUnits(p);
  if (!price && units.length === 0) return undefined;
  return { ...(price ?? {}), ...(units.length > 0 ? { units } : {}) };
}

/** Vercel AI Gateway `getAvailableModels()` pricing block ($/token). */
export function vercelGatewayPrice(
  p:
    | {
        input?: unknown;
        output?: unknown;
        cachedInputTokens?: unknown;
        cacheCreationInputTokens?: unknown;
        input_cache_read?: unknown;
        input_cache_write?: unknown;
        video_duration_pricing?: unknown;
        video_token_pricing?: unknown;
      }
    | null
    | undefined
): ModelPrice | undefined {
  if (!p) return undefined;
  const price = buildPrice({
    input: p.input,
    output: p.output,
    cacheRead: firstDefined(p.cachedInputTokens, p.input_cache_read),
    cacheWrite: firstDefined(p.cacheCreationInputTokens, p.input_cache_write)
  });
  const videoDurationUnits = vercelVideoDurationPriceUnits(p.video_duration_pricing);
  const videoTokenUnits = vercelVideoTokenPriceUnits(p.video_token_pricing);
  const videoSecond = videoDurationUnits[0]?.price;
  const units = [...videoDurationUnits, ...videoTokenUnits];
  const withVideo = videoSecond === undefined ? price : { ...(price ?? {}), videoSecond };
  if (!withVideo && units.length === 0) return undefined;
  return { ...(withVideo ?? {}), ...(units.length > 0 ? { units } : {}) };
}

export const providerViewSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.enum(KNOWN_PROVIDER_TYPES),
  baseUrl: httpUrlSchema.optional(),
  extra: z.record(z.string(), z.string()).optional()
});
export type ProviderView = z.infer<typeof providerViewSchema>;

export const generationParamsViewSchema = z.object({
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
  topP: z.number().optional(),
  reasoningEffort: z.string().optional()
});
export type GenerationParamsView = z.infer<typeof generationParamsViewSchema>;
/** Canonical generation params (single source). agent-core / sdk-atom / home all derive from
 *  this rather than redeclaring the shape. Identical to the wire view. */
export type GenerationParams = GenerationParamsView;

export const fallbackTargetViewSchema = z.union([
  z.object({ profile: z.string() }),
  z.object({ provider: z.string(), modelId: z.string() })
]);
export type FallbackTargetView = z.infer<typeof fallbackTargetViewSchema>;

export const profileViewSchema = z.object({
  alias: z.string(),
  routes: modelProfileRoutesSchema,
  params: generationParamsViewSchema,
  routeParams: z.partialRecord(modelRoleSchema, generationParamsViewSchema).optional(),
  fallbacks: z.array(fallbackTargetViewSchema)
});
export type ProfileView = z.infer<typeof profileViewSchema>;

export const credentialViewSchema = z.object({
  id: z.string(),
  label: z.string(),
  authType: z.enum(['api_key', 'oauth', 'admin_api_key']),
  priority: z.number(),
  source: z.string(),
  baseUrl: httpUrlSchema.optional(),
  lastStatus: z.enum(['ok', 'error', 'unknown']),
  requestCount: z.number(),
  accessTokenPreview: z.string().optional() // masked tail, e.g. "…a1b2" — never the full token
});
export type CredentialView = z.infer<typeof credentialViewSchema>;

export const listProvidersResponseSchema = z.object({ providers: z.array(providerViewSchema) });
export type ListProvidersResponse = z.infer<typeof listProvidersResponseSchema>;

export const setProviderRequestSchema = z.object({ provider: providerViewSchema });
export type SetProviderRequest = z.infer<typeof setProviderRequestSchema>;

export const listProfilesResponseSchema = z.object({
  profiles: z.array(profileViewSchema),
  defaultAlias: z.string()
});
export type ListProfilesResponse = z.infer<typeof listProfilesResponseSchema>;

export const setProfileRequestSchema = z.object({ profile: profileViewSchema });
export type SetProfileRequest = z.infer<typeof setProfileRequestSchema>;

export const renameProfileRequestSchema = z.object({ alias: z.string() });
export type RenameProfileRequest = z.infer<typeof renameProfileRequestSchema>;

export const setDefaultProfileRequestSchema = z.object({ alias: z.string() });
export type SetDefaultProfileRequest = z.infer<typeof setDefaultProfileRequestSchema>;

export const getDefaultProfileResponseSchema = z.object({ alias: z.string() });
export type GetDefaultProfileResponse = z.infer<typeof getDefaultProfileResponseSchema>;

export const modelPriceSchema = z
  .object({
    input: z.number().optional(),
    output: z.number().optional(),
    cacheRead: z.number().optional(),
    cacheWrite: z.number().optional(),
    videoSecond: z.number().optional(),
    units: z
      .array(
        z.object({
          label: z.string(),
          price: z.number(),
          unit: z.string()
        })
      )
      .optional()
  })
  .partial();
export type ModelPrice = z.infer<typeof modelPriceSchema>;

// Model capabilities (drives the model-role picker).
// `kind` is the model's primary output role; `vision` is a separate input capability surfaced via
// `input` containing "image". Data comes from the provider's listModels when rich, else the
// models.dev catalog by id (mirroring price). embedding is detected by id (models.dev doesn't flag
// it via modality), so kind=embedding is authoritative even when modalities look like text→text.
export const modelKindSchema = z.enum([
  'chat',
  'image',
  'video',
  'speech',
  'embedding',
  'audio',
  'rerank',
  'transcription'
]);
export type ModelKind = z.infer<typeof modelKindSchema>;

/** A model-assignment slot. `chat` is special (it resolves to a profile, with params + fallback);
 *  the rest are profile role overrides. `vision` is a chat
 *  model that accepts image input. The role → required-capability mapping the UI filters on:
 *  chat=output⊇text · vision=input⊇image · image=output⊇image · speech=output⊇speech ·
 *  transcription=kind|output⊇transcription · embedding=kind. */
export const getRolesResponseSchema = z.object({ roles: modelRolesSchema });
export type GetRolesResponse = z.infer<typeof getRolesResponseSchema>;
export const setRolesRequestSchema = z.object({ roles: modelRolesSchema });
export type SetRolesRequest = z.infer<typeof setRolesRequestSchema>;
export const transcribeAudioRequestSchema = z.object({
  audioBase64: z.string().min(1).max(25_000_000),
  mediaType: z.string().min(1).max(200).optional(),
  language: z.string().min(1).max(64).optional()
});
export type TranscribeAudioRequest = z.infer<typeof transcribeAudioRequestSchema>;
export const transcribeAudioResponseSchema = z.object({ text: z.string() });
export type TranscribeAudioResponse = z.infer<typeof transcribeAudioResponseSchema>;

export const modelModalitiesSchema = z.object({
  input: z.array(z.string()).optional(),
  output: z.array(z.string()).optional(),
  reasoning: z.boolean().optional(),
  reasoningEfforts: z.array(z.string()).optional(),
  defaultReasoningEffort: z.string().optional(),
  toolCall: z.boolean().optional(),
  kind: modelKindSchema.optional()
});
export type ModelModalities = z.infer<typeof modelModalitiesSchema>;

export const modelInfoSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  price: modelPriceSchema.optional(), // USD per 1M tokens; provider-native price preferred, else catalog
  modalities: modelModalitiesSchema.optional(), // input/output modalities, flags, kind; provider-native preferred, else catalog
  contextLimit: z.number().int().positive().optional(),
  releaseDate: z.string().optional(),
  detailUrl: httpsUrlSchema.optional(),
  modelsDevUrl: httpsUrlSchema.optional()
});
export type ModelInfo = z.infer<typeof modelInfoSchema>;

export const listModelsResponseSchema = z.object({
  providerId: z.string(),
  models: z.array(modelInfoSchema)
});
export type ListModelsResponse = z.infer<typeof listModelsResponseSchema>;

export const listCredentialsResponseSchema = z.object({
  providerId: z.string(),
  credentials: z.array(credentialViewSchema)
});
export type ListCredentialsResponse = z.infer<typeof listCredentialsResponseSchema>;

// `providerId` travels in the path params; HTTP body derives via .omit().
export const addCredentialRequestSchema = z.object({
  providerId: z.string(),
  label: z.string(),
  authType: z.enum(['api_key', 'oauth', 'admin_api_key']),
  accessToken: z.string(),
  baseUrl: httpUrlSchema.optional(),
  priority: z.number().optional()
});
export type AddCredentialRequest = z.infer<typeof addCredentialRequestSchema>;

export const addCredentialBodySchema = addCredentialRequestSchema.omit({ providerId: true });

export const addCredentialResponseSchema = z.object({ id: z.string() });
export type AddCredentialResponse = z.infer<typeof addCredentialResponseSchema>;

// `providerId` + `credentialId` travel in path params; HTTP body derives via .pick().
export const testCredentialRequestSchema = z.object({
  providerId: z.string(),
  credentialId: z.string(),
  /** Model id to probe with; falls back to a profile that uses this provider. */
  modelId: z.string().optional()
});
export type TestCredentialRequest = z.infer<typeof testCredentialRequestSchema>;

export const deleteCredentialRequestSchema = testCredentialRequestSchema.pick({
  providerId: true,
  credentialId: true
});
export type DeleteCredentialRequest = z.infer<typeof deleteCredentialRequestSchema>;

export const testCredentialBodySchema = testCredentialRequestSchema.pick({ modelId: true }).optional();

export const testCredentialResponseSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().optional(),
  error: z.string().optional()
});
export type TestCredentialResponse = z.infer<typeof testCredentialResponseSchema>;

// Stateless "test before add": lists the provider's model catalogue (authenticated GET,
// no generation tokens spent) without persisting anything. On success, `models` is
// returned so the UI can immediately offer model choices.
export const testConnectionRequestSchema = z.object({
  provider: providerViewSchema,
  accessToken: z.string()
});
export type TestConnectionRequest = z.infer<typeof testConnectionRequestSchema>;

export const testConnectionResponseSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().optional(),
  error: z.string().optional(),
  models: z.array(modelInfoSchema).optional()
});
export type TestConnectionResponse = z.infer<typeof testConnectionResponseSchema>;

export const okResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof okResponseSchema>;

// Skills: L1 metadata only — bodies are loaded lazily, not here.
export const skillListItemSchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.string().optional(),
  icon: z.string().optional(),
  userInvocable: z.boolean(),
  available: z.boolean(), // false → host doesn't meet `requires` gates; hidden from agent
  unavailable: z.array(z.string()).optional(), // unmet gate tags, e.g. `bin:git`, `env:API_KEY`
  tier: z.enum(['fast']).optional(), // capability tier of a `context: fork` skill
  compatibility: z.string().optional() // advisory environment requirement (non-blocking)
});
export type SkillListItem = z.infer<typeof skillListItemSchema>;

export const skillListInstanceSchema = skillListItemSchema.extend({
  id: z.string(),
  sourceKind: z.enum(['global', 'atom-pack', 'agent']),
  sourceId: z.string(),
  source: z.string(),
  active: z.boolean()
});
export type SkillListInstance = z.infer<typeof skillListInstanceSchema>;

export const listSkillsScopeSchema = z
  .preprocess((value) => (Array.isArray(value) ? value.join(',') : value), z.string().optional())
  .default('runtime')
  .refine(
    (value) =>
      value === 'runtime' || value.split(',').every((scope) => ['global', 'atom-pack', 'agent'].includes(scope)),
    'expected runtime or a comma-separated list of global, atom-pack, agent'
  );
export const listSkillsQuerySchema = z.object({
  scope: listSkillsScopeSchema
});
export type ListSkillsQuery = z.infer<typeof listSkillsQuerySchema>;
export type ListSkillsQueryInput = {
  scope?: ListSkillsQuery['scope'] | Array<'global' | 'atom-pack' | 'agent'>;
};

export const listSkillsResponseSchema = z.object({
  skills: z.array(skillListItemSchema),
  skillInstances: z.array(skillListInstanceSchema).default([])
});
export type ListSkillsResponse = z.infer<typeof listSkillsResponseSchema>;

export const initMissingItemSchema = z.enum(['provider', 'credential', 'default', 'agent']);
export type InitMissingItem = z.infer<typeof initMissingItemSchema>;

export const missingProviderCredentialSchema = z.object({
  providerId: z.string(),
  providerLabel: z.string().optional(),
  profileAlias: z.string(),
  route: z.literal('chat')
});
export type MissingProviderCredential = z.infer<typeof missingProviderCredentialSchema>;

export const getInitStatusResponseSchema = z.object({
  initialized: z.boolean(),
  missing: z.array(initMissingItemSchema),
  missingProviderCredentials: z.array(missingProviderCredentialSchema).optional(),
  homePath: z.string()
});
export type GetInitStatusResponse = z.infer<typeof getInitStatusResponseSchema>;

export const setInitHomeRequestSchema = z.object({ path: z.string().min(1) });
export type SetInitHomeRequest = z.infer<typeof setInitHomeRequestSchema>;

const envDepStateSchema = z.enum(['found', 'installed', 'missing']);
export const envDepsStatusResponseSchema = z.object({
  node: envDepStateSchema,
  uv: envDepStateSchema
});
export type EnvDepsStatusResponse = z.infer<typeof envDepsStatusResponseSchema>;

export const installEnvDepsRequestSchema = z.object({
  installNode: z.boolean().optional(),
  installUv: z.boolean().optional()
});
export type InstallEnvDepsRequest = z.infer<typeof installEnvDepsRequestSchema>;

const envDepResultSchema = z.enum(['found', 'installed', 'failed', 'skipped']);
export const installEnvDepsResponseSchema = z.object({
  node: envDepResultSchema,
  uv: envDepResultSchema,
  errors: z.record(z.string(), z.string()).optional()
});
export type InstallEnvDepsResponse = z.infer<typeof installEnvDepsResponseSchema>;

export const listAtomKindsResponseSchema = z.object({ kinds: z.array(z.string()) });
export type ListAtomKindsResponse = z.infer<typeof listAtomKindsResponseSchema>;

const atomDiscoverErrorSchema = z.object({ file: z.string(), error: z.string() });
export const discoverAtomKindsResponseSchema = z.object({
  registered: z.array(z.string()),
  errors: z.array(atomDiscoverErrorSchema)
});
export type DiscoverAtomKindsResponse = z.infer<typeof discoverAtomKindsResponseSchema>;

export const clientFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), sessionId: sessionIdSchema }),
  z.object({ type: z.literal('unsubscribe'), sessionId: sessionIdSchema }),
  z.object({ type: z.literal('ping') })
]);
export type ClientFrame = z.infer<typeof clientFrameSchema>;

export const serverFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('event'), sessionId: sessionIdSchema, payload: eventSchema }),
  z.object({ type: z.literal('pong') })
]);
export type ServerFrame = z.infer<typeof serverFrameSchema>;

export type InfinitePaginateResponse<T, K extends string = 'data'> = {
  [P in K]: T[];
} & { nextCursor?: string; previousCursor?: string };

export type PaginateResponse<T, K extends string = 'data'> = {
  [P in K]: T[];
} & { limit: number; offset: number; total: number };
