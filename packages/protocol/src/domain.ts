import type { AgentId, ISO8601, PrincipalId, SessionId, TaskId } from './ids.ts';

import { z } from 'zod';

import {
  agentIdSchema,
  eventIdSchema,
  iso8601Schema,
  messageIdSchema,
  principalIdSchema,
  projectIdSchema,
  sessionIdSchema,
  taskIdSchema
} from './ids.ts';

// Schema-first at wire boundaries (HTTP/WS/disk). Types with no runtime boundary yet
// stay hand-written — convert them when they gain a wire boundary.

export interface Principal {
  id: PrincipalId;
  kind: 'human' | 'builder' | 'external' | 'system';
  displayName: string;
  verification: 'unverified' | 'email' | 'domain' | 'attested';
}

const scopeSchema = z.object({
  resource: z.string(),
  constraints: z.record(z.string(), z.unknown()).optional()
});

export type Scope = z.infer<typeof scopeSchema>;

// Filesystem sandbox scope. Single source of truth — @monad/home re-exports this so the
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

// Model routing roles (single source of truth — control.ts + @monad/home re-export).
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

export const agentSchema = z.object({
  id: agentIdSchema,
  principalId: principalIdSchema,
  name: z.string(),
  description: z.string().optional(),
  modelAlias: z.string().optional(),
  /** Per-agent model-role overrides; unset roles inherit the selected profile. */
  roles: modelRolesSchema.optional(),
  /** Profile alias | 'inherit'. Defaults to inherit when unset. */
  model: z.string().optional(),
  framework: z.enum(['openclaw', 'hermes', 'manus', 'monad', 'custom']).optional(),
  capabilities: z.array(z.string()).default([]),
  declaredScopes: z.array(scopeSchema).default([]),
  atoms: agentAtomsSchema.optional(),
  sandboxMode: sandboxModeSchema.optional(),
  maxTurns: z.number().int().positive().optional(),
  maxThinkingTokens: z.number().int().positive().optional(),
  maxBudgetUsd: z.number().positive().optional(),
  visibility: agentVisibilitySchema.default({ subagentCallable: false, public: false }),
  a2a: a2aAgentSettingsSchema.default({ enabled: false }),
  monadix: monadixAgentSettingsSchema.default({ consume: false }),
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
 * Open extension bag for client-defined provenance the predefined fields don't cover. The strict
 * core above is the contract UIs render structurally; `ext` is freeform and a UI may only display it
 * as raw key/values — never assume a shape. Client-controlled + persisted, so it is bounded (≤32
 * keys, ≤4KB serialized) against DoS, and like `env` it MUST NOT enter the model context.
 */
export const sessionOriginExtSchema = z
  .record(z.string().max(64), z.unknown())
  .refine((o) => Object.keys(o).length <= 32, 'too many ext keys (max 32)')
  .refine((o) => JSON.stringify(o).length <= 4096, 'ext too large (max 4KB serialized)');
export type SessionOriginExt = z.infer<typeof sessionOriginExtSchema>;

/**
 * Provenance + access policy + environment snapshot, captured once at session creation and
 * immutable thereafter. Two-part metadata: a strict PREDEFINED core (UI renders it structurally)
 * plus an open `ext` extension bag (UI shows raw). Layered after how MCP/LSP (identity vs.
 * capabilities) and OTel/Segment (environment context) model client origin:
 *   · identity — `surface` (coarse, closed) + `client` (concrete, open) + version/instance
 *   · access   — `writableBy` (who may send into this session) + `branchableBy` (who may fork it);
 *                two orthogonal policies, each derived from `surface` but explicitly overridable
 *   · env      — audit/telemetry snapshot; MUST NOT enter the model context (PII +
 *                prompt-injection surface). See docs/engineering/security-guidelines.md.
 *   · ext      — open client extension; strict only as bounded JSON; UI renders raw.
 */
export const sessionOriginSchema = z.object({
  surface: sessionSurfaceSchema,
  /** Concrete client/product, open string: 'telegram' | 'slack' | 'zed' | 'vscode' | 'monad-web'. */
  client: z.string(),
  clientVersion: z.string().optional(),
  /** Disambiguates one surface across many instances: channelId, deployment/vendor id, … */
  instanceId: z.string().optional(),
  /** Physical channel that created the session (matched against on every write). */
  transport: sessionTransportSchema,
  /** Which transports may write. Defaulted from `surface` at creation; overridable. */
  writableBy: z.array(sessionTransportSchema),
  /** Which transports may fork (branch) this session. Orthogonal to `writableBy` — a session can be
   *  writable-but-not-forkable or vice versa. Defaulted from `surface` at creation; overridable. */
  branchableBy: z.array(sessionTransportSchema),
  /**
   * Environment snapshot — audit/telemetry only, NEVER fed to the model. Every field is optional and
   * transport-specific: each originating transport fills only what it can observe, so a field's
   * absence just means "that transport had no such thing", not an error.
   */
  env: z
    .object({
      os: z.enum(['darwin', 'linux', 'windows']).optional(), // any local transport (host OS)
      ip: z.string().optional(), // HTTP only
      userAgent: z.string().optional(), // HTTP only
      referer: z.string().optional(), // HTTP only — the Referer header; absent on ACP/channel/native
      locale: z.string().optional(), // HTTP (Accept-Language); could also come from an editor
      workspace: z.string().optional() // ACP only (the editor cwd)
    })
    .optional(),
  /** Open client-defined extension (see sessionOriginExtSchema). UI renders raw; never to the model. */
  ext: sessionOriginExtSchema.optional()
});
export type SessionOrigin = z.infer<typeof sessionOriginSchema>;

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
  /** Set when this session belongs to a Workplace Project (Track B); absent for a plain chat session.
   *  See docs/proposals/project-session-decoupling.md. */
  projectId: projectIdSchema.optional(),
  title: z.string(),
  ownerPrincipalId: principalIdSchema,
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
  /** Provenance, write policy, and environment snapshot (absent on legacy rows). */
  origin: sessionOriginSchema.optional(),
  createdAt: iso8601Schema,
  updatedAt: iso8601Schema
});
export type Session = z.infer<typeof sessionSchema>;

export type TaskState =
  | 'pending'
  | 'awaiting_gate' // reserved for the deferred oversight layer
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface Task {
  id: TaskId;
  sessionId: SessionId;
  title: string;
  assigneeAgentId: AgentId | null;
  dependsOn: TaskId[]; // DAG edges — all must succeed before this task starts
  state: TaskState;
  version: number; // optimistic-concurrency token (CAS)
  result?: unknown;
  error?: { code: string; message: string };
  createdAt: ISO8601;
  updatedAt: ISO8601;
}

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

/** A subscription handle: how a client replays + tails the live generation of THIS message.
 * `channel` names the event sub-stream (default = the assistant token stream via `agent.token`);
 * a non-assistant generative message streams over `message.delta` keyed by this `channel`.
 * `afterEventId` is the resume cursor. */
export const streamRefSchema = z.object({
  sessionId: sessionIdSchema,
  messageId: messageIdSchema,
  channel: z.string().optional(),
  afterEventId: eventIdSchema.optional()
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
  sessionId: sessionIdSchema,
  role: messageRoleSchema,
  text: z.string(),
  type: messageTypeSchema,
  data: z.unknown().optional(), // structured payload matching `type` (card / tool args / directive…)
  stream: messageStreamSchema,
  active: z.boolean(), // false = rewound/hidden
  // Per-message override of the type's default context policy. Absent ⇒ use the registry default
  // for `type` (see resolveMessageType). false ⇒ excluded from the prompt, token stats, and summary.
  // Orthogonal to `active` (which hides everything regardless).
  includeInContext: z.boolean().optional(),
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
  'session.stream_started', // a turn began generating — control-plane signal for clients to open an SSE generation subscription
  'session.stream_ended', // the turn settled (success/error/abort) — clients close the SSE generation subscription
  'task.created',
  'task.progress',
  'task.completed',
  'task.failed',
  'mcp.status_updated',
  'user.message', // a human/channel-originated turn was accepted (lets other clients render it live)
  'agent.message', // agent-to-human note (renderable)
  'agent.token', // streamed model token chunk
  'agent.reasoning', // streamed extended-thinking/reasoning delta (separate from the answer)
  'agent.error', // model or gateway error surfaced to the session
  'message.delta', // streamed delta of a non-assistant generative message (keyed by messageId + channel)
  'message.complete', // a generative message reached a terminal state (complete | error)
  'tool.called',
  'tool.progress', // streamed partial output from a running tool (e.g. live shell output)
  'tool.result',
  'tool.approval_requested', // a high-risk tool call is blocked awaiting human approval
  'tool.approval_resolved', // approval granted, denied, or timed out
  'clarify.requested', // the agent is blocked asking the user a free-text question
  'clarify.resolved', // the user answered, or the request timed out
  'context.usage', // a context-window breakdown (token consumption by category)
  // Reverse fs/terminal delegation (ACP bridge): the daemon asks the connected editor to perform an
  // fs op / run a terminal command on its side; the editor answers via the `delegation.respond` RPC
  // (and streams terminal output via `delegation.output`). Bus-only (never persisted) — ephemeral RPC.
  'delegation.fs_request',
  'delegation.terminal_request',
  'external_agent.started',
  'external_agent.output',
  'external_agent.connection_required',
  'external_agent.approval_requested',
  'external_agent.approval_resolved',
  'external_agent.resume_failed',
  'external_agent.exited'
]);
export type EventType = z.infer<typeof eventTypeSchema>;

export const eventSchema = z.object({
  id: eventIdSchema,
  sessionId: sessionIdSchema,
  type: eventTypeSchema,
  actorAgentId: agentIdSchema.nullable(), // null = system- or human-originated
  taskId: taskIdSchema.optional(),
  payload: z.record(z.string(), z.unknown()),
  at: iso8601Schema
});
export type Event = z.infer<typeof eventSchema>;

// Typed event payloads are schema-first: defined as Zod schemas in event-table.ts and
// re-exported here as `z.infer` types for backward compatibility. Runtime parse via
// `parseEventPayload` / `assertEventPayload` (see event-table.ts).

export const finishReasonSchema = z.enum(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']);
export type FinishReason = z.infer<typeof finishReasonSchema>;

export type {
  AgentErrorPayload,
  AgentMessagePayload,
  AgentReasoningPayload,
  AgentTokenPayload,
  ClarifyRequestedPayload,
  ClarifyResolvedPayload,
  ContextUsagePayload,
  EventPayload,
  MessageCompletePayload,
  MessageDeltaPayload,
  SessionCreatedPayload,
  SessionRestoredPayload,
  SessionUpdatedPayload,
  ToolApprovalRequestedPayload,
  ToolApprovalResolvedPayload,
  ToolCalledPayload,
  ToolProgressPayload,
  ToolResultPayload,
  UserMessagePayload
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
