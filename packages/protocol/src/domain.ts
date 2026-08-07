import { z } from 'zod';

import { channelChatTypeSchema } from './channel.ts';
import {
  agentIdSchema,
  eventIdSchema,
  iso8601Schema,
  messageIdSchema,
  projectIdSchema,
  sessionIdSchema,
  taskIdSchema,
  transcriptTargetIdSchema
} from './ids.ts';

// Schema-first at wire boundaries (HTTP/WS/disk). Types with no runtime boundary yet
// stay hand-written — convert them when they gain a wire boundary.

const resourceScopeSchema = z.object({
  resource: z.string(),
  constraints: z.record(z.string(), z.unknown()).optional()
});

export type ResourceScope = z.infer<typeof resourceScopeSchema>;

// Filesystem sandbox scope. Single source of truth — @monad/environment re-exports this so the
// home config and the wire `agentSchema` share one definition (protocol can't depend on home).
//   "workspace"    → fs:* confined to ~/.monad/workspace/ (default)
//   "home"         → fs:* confined to the user's home directory
//   "unrestricted" → no filesystem boundary (must be explicitly set)
//   "ephemeral"    → each session gets a fresh disposable root, removed when the session ends
export const sandboxModeSchema = z.enum(['workspace', 'home', 'unrestricted', 'ephemeral']);
export type SandboxMode = z.infer<typeof sandboxModeSchema>;

/** Two independent visibility toggles. "Standalone use" is the always-on baseline, so it is
 *  not stored. `subagentCallable` → other agents may delegate to it (in-process peer).
 *  `public` → published as a Monadix provider (separate process/identity). */
export const agentVisibilitySchema = z.object({
  subagentCallable: z.boolean().default(false),
  public: z.boolean().default(false)
});
export type AgentVisibility = z.infer<typeof agentVisibilitySchema>;

/** Per-agent A2A (Agent2Agent) exposure. When `enabled`, the daemon serves a standard A2A
 *  surface for this agent — an AgentCard plus JSON-RPC `message/send`, `message/stream`, and
 *  `tasks/*` — scoped to its id. Off by default: exposing an agent to external A2A clients is
 *  an opt-in per agent. */
export const a2aAgentSettingsSchema = z.object({
  enabled: z.boolean().default(false)
});
export type A2aAgentSettings = z.infer<typeof a2aAgentSettingsSchema>;

/** Per-agent Monadix consumer setting. When `consume`, this agent is exposed the `monadix__*` tools
 *  (delegate/match/etc.) so it can hand work OUT to the Monadix network. Off by default and gated
 *  behind the daemon-level `monadix.enabled` login; the provider (publish) direction is the separate
 *  `visibility.public` toggle. */
export const monadixAgentSettingsSchema = z.object({
  consume: z.boolean().default(false)
});
export type MonadixAgentSettings = z.infer<typeof monadixAgentSettingsSchema>;

/** Per-agent tool/atom exposure — a *filter* over the daemon-registered tools, never an installer.
 *  `allow` narrows to a subset; `deny` removes from the inherited/allowed set. Exposure ⊆ registration. */
export const agentAtomsSchema = z.object({
  mode: z.enum(['inherit', 'allowlist']).default('inherit'),
  allow: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([])
});
export type AgentAtoms = z.infer<typeof agentAtomsSchema>;

// Model routing roles (single source of truth — control.ts + @monad/environment re-export).
// A model profile is a recipe of route slots: `chat` is the required default model, `fast` is the
// lightweight lane, and the remaining roles are capability-specific overrides.
export const modelRoleSchema = z.enum([
  'chat',
  'fast',
  'vision',
  'image',
  'video',
  'speech',
  'transcription',
  'embedding',
  'memory'
]);
export type ModelRole = z.infer<typeof modelRoleSchema>;

// Abstract capability tier for tier-based model selection (fork skills, routing): the layer resolves
// a tier to a concrete configured model, cheapest → priciest, so callers name a tier not a vendor model.
export const modelTierSchema = z.enum(['fast', 'smart', 'power']);
export type ModelTier = z.infer<typeof modelTierSchema>;

export const modelRouteTargetSchema = z.object({
  provider: z.string(),
  modelId: z.string()
});
export type ModelRouteTarget = z.infer<typeof modelRouteTargetSchema>;

export const modelProfileRoutesSchema = z.object({
  chat: modelRouteTargetSchema,
  fast: modelRouteTargetSchema.optional(),
  vision: modelRouteTargetSchema.optional(),
  image: modelRouteTargetSchema.optional(),
  video: modelRouteTargetSchema.optional(),
  speech: modelRouteTargetSchema.optional(),
  transcription: modelRouteTargetSchema.optional(),
  embedding: modelRouteTargetSchema.optional(),
  memory: modelRouteTargetSchema.optional()
});
export type ModelProfileRoutes = z.infer<typeof modelProfileRoutesSchema>;

export const modelRolesSchema = z.object({
  fast: z.string().optional(),
  vision: z.string().optional(),
  image: z.string().optional(),
  video: z.string().optional(),
  speech: z.string().optional(),
  transcription: z.string().optional(),
  embedding: z.string().optional(),
  memory: z.string().optional()
});
export type ModelRoles = z.infer<typeof modelRolesSchema>;

export const agentDirSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export type AgentDir = z.infer<typeof agentDirSchema>;

export const agentSkillsSchema = z.object({
  mode: z.enum(['inherit', 'allowlist']).default('inherit'),
  allow: z.array(z.string()).default([]),
  autoload: z.boolean().optional(),
  disabled: z.array(z.string()).default([])
});
export type AgentSkills = z.infer<typeof agentSkillsSchema>;

export const agentMemorySettingsSchema = z.object({
  enabled: z.boolean(),
  advanced: z.boolean(),
  autoConsolidate: z.boolean(),
  intervalMinutes: z.number().int().positive()
});
export type AgentMemorySettings = z.infer<typeof agentMemorySettingsSchema>;

export const agentSchema = z.object({
  id: agentIdSchema,
  name: z.string(),
  dir: agentDirSchema.optional(),
  modelAlias: z.string().optional(),
  /** Per-agent model-role overrides; unset roles inherit the selected profile. */
  roles: modelRolesSchema.optional(),
  /** Profile alias | 'inherit'. Defaults to inherit when unset. */
  model: z.string().optional(),
  framework: z.enum(['openclaw', 'hermes', 'manus', 'monad', 'custom']).optional(),
  capabilities: z.array(z.string()).default([]),
  credentialIds: z.array(z.string()).default([]),
  declaredScopes: z.array(resourceScopeSchema).default([]),
  skills: agentSkillsSchema.optional(),
  atoms: agentAtomsSchema.optional(),
  sandboxMode: sandboxModeSchema.optional(),
  maxTurns: z.number().int().positive().optional(),
  maxThinkingTokens: z.number().int().positive().optional(),
  maxBudgetUsd: z.number().positive().optional(),
  visibility: agentVisibilitySchema.default({ subagentCallable: false, public: false }),
  a2a: a2aAgentSettingsSchema.default({ enabled: false }),
  monadix: monadixAgentSettingsSchema.default({ consume: false }),
  memory: agentMemorySettingsSchema,
  /** True when an AGENT.md body exists on disk — UI hint without shipping the prompt over the wire. */
  hasPrompt: z.boolean().optional()
});
export type Agent = z.infer<typeof agentSchema>;

export const sessionStateSchema = z.enum(['active', 'paused', 'completed', 'cancelled', 'failed']);
export type SessionState = z.infer<typeof sessionStateSchema>;

/** Coarse, closed kind of originating surface. Drives the default write policy. */
export const sessionSurfaceSchema = z.enum(['editor', 'web', 'tui', 'im', 'api', 'automation']);
export type SessionSurface = z.infer<typeof sessionSurfaceSchema>;

/** Physical channel a write arrives on — the unit access control matches against. */
export const sessionTransportSchema = z.enum(['http', 'acp', 'channel']);
export type SessionTransport = z.infer<typeof sessionTransportSchema>;

/**
 * Provenance captured once at session creation and immutable thereafter — a strict identity core
 * the UI renders structurally. Layered after how MCP/LSP model client identity vs. capabilities:
 * `surface` (coarse, closed) + `client` (concrete, open) + version/instance + originating transport.
 */
export const operationSourceSchema = z.object({
  surface: sessionSurfaceSchema,
  /** Concrete client/product, open string: 'telegram' | 'slack' | 'zed' | 'vscode' | 'monad-web'. */
  client: z.string(),
  clientVersion: z.string().optional(),
  /** Disambiguates one surface across many instances: channelId, deployment/vendor id, … */
  instanceId: z.string().optional(),
  /** Physical channel that created the session — provenance only, not a write-admission policy. */
  transport: sessionTransportSchema
});
export type OperationSource = z.infer<typeof operationSourceSchema>;

/**
 * Per-message ingress provenance, captured at delivery. Unlike the session's immutable
 * `operationSource`, a message's origin describes the write that carried IT — a web reply typed
 * into a Telegram-born session records `http`, not the session's `channel`. Only `transport` is
 * always knowable; surface/client details are borrowed from the session origin when the write
 * arrived over the same transport, or supplied by the channel dispatch itself.
 */
export const messageOriginSchema = operationSourceSchema
  .partial()
  .required({ transport: true })
  .extend({
    /** Platform-side sender id for channel-delivered messages (e.g. the Telegram user id). */
    senderId: z.string().min(1).optional(),
    /** Sender's display name on the source platform, as the adapter reported it. */
    senderDisplay: z.string().min(1).optional(),
    /** Human-readable conversation name ("#general", "Dev Team"); absent when the adapter has none. */
    chatTitle: z.string().min(1).optional(),
    /** Shape of the source conversation — a reader distinguishes a DM from a public channel. */
    chatType: channelChatTypeSchema.optional(),
    /** Platform thread/topic the message landed in, when the channel supports threads. */
    threadId: z.string().min(1).optional()
  });
export type MessageOrigin = z.infer<typeof messageOriginSchema>;

/** Open envelope for durable per-message annotations; `origin` is its first citizen. */
export const messageMetadataSchema = z.object({
  origin: messageOriginSchema.optional()
});
export type MessageMetadata = z.infer<typeof messageMetadataSchema>;

export const tokenUsageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  totalTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
  reasoningTokens: z.number().optional()
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

/**
 * The USD cost of a turn. `source` records how it was derived: `provider` (the provider returned
 * a real cost, e.g. OpenRouter), `catalog_price` (real token usage × a model-name-matched
 * catalog price — `approximate` only because the price is name-matched), or `unknown` (no real
 * usage, or no price found — never estimated). Money is never inferred from estimated tokens.
 */
export const costSchema = z.object({
  usd: z.number().optional(),
  source: z.enum(['provider', 'catalog_price', 'unknown']),
  approximate: z.boolean()
});
export type Cost = z.infer<typeof costSchema>;

export const sessionSchema = z.object({
  id: sessionIdSchema,
  /** Set when this session belongs to a Workplace Project; absent for a plain chat session.
   *  See docs/internals/agent-team-runtime/project-sessions.md. */
  projectId: projectIdSchema.optional(),
  title: z.string(),
  state: sessionStateSchema,
  agentIds: z.array(agentIdSchema),
  archived: z.boolean(),
  restoreCount: z.number(), // how many times this session was restored/rewound (audit)
  /** Per-session model-profile alias override (set via /model); absent → daemon default. */
  model: z.string().optional(),
  /** Per-session reasoning-effort override; absent inherits the effective profile/model default. */
  reasoningEffort: z.string().optional(),
  /** Default working directory for this session — used for shell commands and skill-path matching.
   * Absent → daemon workspace path (`~/.monad/workspace`). */
  cwd: z.string().optional(),
  usage: tokenUsageSchema.optional(),
  /** Accumulated real USD cost across this session's turns (sum of known per-turn costs). */
  costUsd: z.number().optional(),
  /** Immutable provenance snapshot captured at creation (absent on legacy rows). */
  origin: operationSourceSchema.optional(),
  activityAt: iso8601Schema.optional(),
  /** Client-local placeholder marker: a draft session the web fabricates before the real session is
   *  created. The daemon never sets it; it is absent on every persisted session. */
  isDraft: z.boolean().optional(),
  createdAt: iso8601Schema,
  updatedAt: iso8601Schema
});
export type Session = z.infer<typeof sessionSchema>;

export const messageRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type MessageRole = z.infer<typeof messageRoleSchema>;

/** `(string & {})` keeps this union open — unknown types fall back to `text`.
 * Open unions can't round-trip through z.infer, so the type is hand-written and
 * the schema is intentionally just `z.string()`. */
export type MessageType =
  | 'text'
  | 'markdown'
  | 'tool_call'
  | 'tool_result'
  | 'card'
  | 'directive'
  | 'branch_source'
  | (string & {});
export const messageTypeSchema: z.ZodType<MessageType> = z.string();

// Generation lifecycle for any message. `static` = never generated (user text, pasted content).
// `pending` = generation accepted, first delta not yet emitted. `pending`/`streaming` are live;
// `complete`/`error` are terminal and never transition again.
export const streamStatusSchema = z.enum(['settled', 'pending', 'streaming', 'complete', 'error']);
export type StreamStatus = z.infer<typeof streamStatusSchema>;

/** The identity of one active generated message. Transport cursors and channels belong to the
 *  message-scoped subscription, not the durable message row. */
export const streamRefSchema = z.object({
  transcriptTargetId: transcriptTargetIdSchema,
  messageId: messageIdSchema
});
export type StreamRef = z.infer<typeof streamRefSchema>;

export const messageStreamSchema = z.object({
  status: streamStatusSchema,
  source: streamRefSchema.optional() // present iff status is 'pending' | 'streaming'
});
export type MessageStream = z.infer<typeof messageStreamSchema>;

// Three layers: (1) `text` plain-text fallback any client can render;
// (2) `type`+`data` advanced/structured content for rich UI; (3) `stream` so a UI
// can subscribe to an in-flight assistant turn.
export const chatMessageSchema = z.object({
  id: messageIdSchema,
  sessionId: transcriptTargetIdSchema,
  role: messageRoleSchema,
  text: z.string(),
  type: messageTypeSchema,
  data: z.unknown().optional(), // structured payload matching `type` (card / tool args / directive…)
  replyToMessageId: messageIdSchema.optional(),
  stream: messageStreamSchema,
  active: z.boolean(), // false = rewound/hidden
  // Per-message override of the type's default context policy. Absent ⇒ use the registry default
  // for `type` (see resolveMessageType). false ⇒ excluded from the prompt, token stats, and summary.
  // Orthogonal to `active` (which hides everything regardless).
  includeInContext: z.boolean().optional(),
  /** Durable annotations stamped at delivery (ingress origin, …); absent on legacy rows. */
  metadata: messageMetadataSchema.optional(),
  createdAt: iso8601Schema,
  updatedAt: iso8601Schema.optional() // updated on stream completion / edit
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const searchHitSchema = z.object({
  sessionId: sessionIdSchema,
  transcriptTargetTitle: z.string(),
  messageId: messageIdSchema,
  role: messageRoleSchema,
  snippet: z.string(),
  at: iso8601Schema,
  score: z.number(),
  matchedBy: z.enum(['keyword', 'semantic', 'both'])
});
export type SearchHit = z.infer<typeof searchHitSchema>;

// Local agent event stream over the daemon control API.
// A2A signed-log taxonomy (gate.*, contract.*, action.*) is deferred.
export const eventTypeSchema = z.enum([
  'session.created',
  'session.updated', // title / state / archived changed
  'session.deleted',
  'session.restored',
  'session.run.started',
  'session.run.completed',
  'session.run.failed',
  'session.run.cancelled',
  'agent.session.changed',
  'session.message.created',
  'session.message.updated',
  'session.message.deleted',
  'session.message.delta.appended',
  'session.message.completed',
  'session.message.failed',
  'session.attention.consumed',
  'session.attention.updated',
  'workplace.project.order_updated',
  'task.created',
  'task.progress',
  'task.completed',
  'task.failed',
  'mcp.status_updated',
  'mesh.catalog.updated',
  'tool.called',
  'tool.progress', // streamed partial output from a running tool (e.g. live shell output)
  'tool.result',
  'tool.approval_requested', // a high-risk tool call is blocked awaiting human approval
  'tool.approval_resolved', // approval granted, denied, or timed out
  'clarify.requested', // the agent is blocked asking the user a free-text question
  'clarify.resolved', // the user answered, or the request timed out
  'context.usage', // a context-window breakdown (token consumption by category)
  'context.evicted', // lossless tool-result eviction fired this step — publish-only signal, never persisted (like the stream markers above)
  'context.handoff_suggested', // window past the handoff-nudge fraction at a task boundary — publish-only signal, never persisted
  'memory.suggestion', // memoryPromotion.mode:'suggest' extracted facts from a compacted span — persisted, awaits user confirmation
  // Reverse fs/terminal delegation (ACP bridge): the daemon asks the connected editor to perform an
  // fs op / run a terminal command on its side; the editor answers via the `delegation.respond` RPC
  // (and streams terminal output via `delegation.output`). Bus-only (never persisted) — ephemeral RPC.
  'delegation.fs_request',
  'delegation.terminal_request',
  'mesh.started',
  'mesh.connection_required',
  'mesh.approval_requested',
  'mesh.approval_resolved',
  'mesh.resume_failed',
  'mesh.idle_resumed',
  'mesh.idle_suspended',
  'mesh.exited',
  'mesh.turn_started',
  'mesh.turn_settled',
  'mesh.session.connection.opened',
  'mesh.session.connection.closed',
  // Ephemeral login-nudge pair: published to the session bus only (never persisted), so the
  // in-chat "agent needs to log in" card exists exactly while the condition holds and
  // vanishes on reload — re-auth guidance is transient interaction, not transcript history.
  'mesh.login_required',
  'mesh.login_resolved',
  // Durable session plan state (P0-C) — control-plane only, never wakes/schedules an agent.
  'session.plan.todo_upserted',
  'session.plan.todo_removed'
]);
export type EventType = z.infer<typeof eventTypeSchema>;

export const eventEnvelopeSchema = z.object({
  id: eventIdSchema,
  sessionId: transcriptTargetIdSchema,
  projectId: projectIdSchema.optional(),
  type: eventTypeSchema,
  actorAgentId: agentIdSchema.nullable(), // null = system- or human-originated
  taskId: taskIdSchema.optional(),
  payload: z.record(z.string(), z.unknown()),
  at: iso8601Schema
});
export type Event = z.infer<typeof eventEnvelopeSchema>;

// Typed event payloads are schema-first: defined as Zod schemas in event-table.ts and
// re-exported here as `z.infer` types for backward compatibility. Runtime parse via
// `parseEventPayload` / `assertEventPayload` (see event-table.ts).

export const finishReasonSchema = z.enum(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']);
export type FinishReason = z.infer<typeof finishReasonSchema>;

export type {
  ClarifyRequestedPayload,
  ClarifyResolvedPayload,
  ContextEvictedPayload,
  ContextHandoffSuggestedPayload,
  ContextUsagePayload,
  EventPayload,
  MemorySuggestionPayload,
  SessionCreatedPayload,
  SessionRestoredPayload,
  SessionUpdatedPayload,
  ToolApprovalRequestedPayload,
  ToolApprovalResolvedPayload,
  ToolCalledPayload,
  ToolProgressPayload,
  ToolResultPayload
} from './event-table.ts';

/** The buckets a context window is attributed to (matches the `/context` command breakdown). */
export type ContextCategory =
  | 'systemPrompt'
  | 'systemTools'
  | 'mcpTools'
  | 'memory'
  | 'skills'
  | 'customAgents'
  | 'messages';

/** One attributed slice of the context window. Itemized; clients group by `category`. */
export interface ContextSegment {
  category: ContextCategory;
  label: string;
  tokens: number;
}
