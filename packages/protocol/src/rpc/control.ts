// NOT the A2A collaboration protocol (gates/contracts/signed log) — that is deferred.
// Boundary parsing (HTTP wiring) lives in http.ts.

import { z } from 'zod';

import { approvalScopeSchema } from '../approvals.ts';
import {
  a2aAgentSettingsSchema,
  agentAtomsSchema,
  agentSchema,
  agentVisibilitySchema,
  chatMessageSchema,
  eventSchema,
  modelRolesSchema,
  sandboxModeSchema,
  searchHitSchema,
  sessionOriginExtSchema,
  sessionOriginSchema,
  sessionSchema,
  sessionStateSchema,
  sessionSurfaceSchema,
  sessionTransportSchema
} from '../domain.ts';
import { agentIdSchema, messageIdSchema, sessionIdSchema, transcriptTargetIdSchema } from '../ids.ts';
import {
  cursorPaginationQuerySchema,
  cursorPaginationResponseSchema,
  offsetPaginationQuerySchema,
  offsetPaginationResponseSchema
} from '../pagination.ts';
import { httpUrlSchema } from '../url.ts';

export type {
  CursorPaginationQuery,
  CursorPaginationResponse,
  OffsetPaginationQuery,
  OffsetPaginationResponse
} from '../pagination.ts';

export {
  cursorPaginationQuerySchema,
  cursorPaginationResponseSchema,
  offsetPaginationQuerySchema,
  offsetPaginationResponseSchema
} from '../pagination.ts';

export const CONTROL_API_VERSION = 'v1' as const;

// DoS guard: unbounded strings let a caller exhaust memory with a single request.
export const SESSION_TITLE_MAX = 1_000;
export const MESSAGE_TEXT_MAX = 1_000_000;
export const MESSAGE_ATTACHMENT_MAX = 20;
export const MESSAGE_ATTACHMENT_TEXT_MAX = 512_000;
export const MESSAGE_ATTACHMENT_DATA_MAX = 10_000_000;
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
  a2a: a2aAgentSettingsSchema.optional(),
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
  visibility: agentVisibilitySchema.optional(),
  a2a: a2aAgentSettingsSchema.optional()
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

export const sendMessageAttachmentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('image'),
    name: z.string().min(1).max(500),
    mediaType: z.string().min(1).max(100),
    size: z.number().int().nonnegative(),
    dataBase64: z.string().max(MESSAGE_ATTACHMENT_DATA_MAX)
  }),
  z.object({
    kind: z.literal('text'),
    name: z.string().min(1).max(500),
    mediaType: z.string().min(1).max(100),
    size: z.number().int().nonnegative(),
    text: z.string().max(MESSAGE_ATTACHMENT_TEXT_MAX)
  }),
  z.object({
    kind: z.literal('file-meta'),
    name: z.string().min(1).max(500),
    mediaType: z.string().max(100).optional(),
    size: z.number().int().nonnegative()
  })
]);
export type SendMessageAttachment = z.infer<typeof sendMessageAttachmentSchema>;

export const sendMessageRequestSchema = z.object({
  text: z.string().max(MESSAGE_TEXT_MAX),
  attachments: z.array(sendMessageAttachmentSchema).max(MESSAGE_ATTACHMENT_MAX).optional(),
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
  certStatus: z.enum(['active', 'disabled']).optional(),
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

export const getUsageQuerySchema = offsetPaginationQuerySchema;
export type GetUsageQuery = z.infer<typeof getUsageQuerySchema>;

/** The global usage "账本": cumulative totals + a per-provider/model rollup + the paginated
 *  day/provider/model/category breakdown for multi-dimensional drill-down. */
export const getUsageResponseSchema = offsetPaginationResponseSchema.extend({
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

export const openDraftAttachmentRequestSchema = z.object({
  dataBase64: z.string().max(MESSAGE_ATTACHMENT_DATA_MAX),
  mediaType: z.string().max(200).optional(),
  name: z.string().min(1).max(255)
});
export type OpenDraftAttachmentRequest = z.infer<typeof openDraftAttachmentRequestSchema>;

export const openDraftAttachmentResponseSchema = z.object({
  ok: z.literal(true)
});
export type OpenDraftAttachmentResponse = z.infer<typeof openDraftAttachmentResponseSchema>;

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

export * from './control-model.ts';
