// Payload schemas for every event type the daemon can emit.
//
// The wire Event type keeps `payload: Record<string, unknown>` (backward-compatible)
// so the schema doesn't live on the network boundary. This table lives one layer up:
//   • Publishers can call `assertEventPayload` to get a dev-mode type check.
//   • Subscribers can call `parseEventPayload(event)` to get a typed, validated payload.
//   • TypeScript callers use `EventPayload<T>` for the inferred payload type.
//
// Adding a new event type: add its schema here, then add the type string to
// eventTypeSchema in domain.ts. The exhaustiveness check in event-table.test.ts
// will fail until both are in sync.

import { z } from 'zod';

import { clarifyAskerSchema, clarifyChoiceModeSchema } from './clarify.ts';
import { costSchema, type EventType, finishReasonSchema, messageTypeSchema, tokenUsageSchema } from './domain.ts';
import {
  externalAgentLaunchModeSchema,
  externalAgentProductIconSchema,
  externalAgentProviderSchema,
  messageAttachmentRefSchema
} from './external-agent/index.ts';
import { agentIdSchema, externalAgentSessionIdSchema, messageIdSchema, nativeAgentDeliveryIdSchema } from './ids.ts';
import { mcpServerStatusSchema } from './mcp-server.ts';

const requestIdSchema = z.string();

export const sessionCreatedPayloadSchema = z.object({
  title: z.string()
});

export const sessionUpdatedPayloadSchema = z.object({
  title: z.string().optional(),
  state: z.string().optional(),
  archived: z.boolean().optional(),
  reset: z.boolean().optional()
});

export const sessionDeletedPayloadSchema = z.object({});

// Stream lifecycle (publish-only, never persisted): a turn began / settled. These ride the
// control topic so a client watching the session list learns *when* to open or close a
// per-session SSE generation subscription — generation tokens themselves never travel the WS.
export const sessionStreamStartedPayloadSchema = z.object({
  // The id of the latest event before this turn, so a late subscriber can resume the SSE
  // stream from here and backfill tokens already emitted. Absent ⇒ resume from the client's
  // own last-seen id (or from now for a fresh watcher).
  afterEventId: z.string().optional()
});

export const sessionStreamEndedPayloadSchema = z.object({});

export const sessionRestoredPayloadSchema = z.object({
  toMessageId: messageIdSchema,
  restoredCount: z.number().int().nonnegative(),
  newHeadMessageId: messageIdSchema.nullable()
});

export const taskCreatedPayloadSchema = z.object({
  taskId: z.string(),
  title: z.string(),
  assigneeAgentId: agentIdSchema.nullable()
});

export const taskProgressPayloadSchema = z.object({
  taskId: z.string(),
  progress: z.string().optional()
});

export const taskCompletedPayloadSchema = z.object({
  taskId: z.string(),
  result: z.unknown().optional()
});

export const taskFailedPayloadSchema = z.object({
  taskId: z.string(),
  error: z.object({ code: z.string(), message: z.string() }).optional()
});

export const mcpStatusUpdatedPayloadSchema = z.object({
  servers: z.array(mcpServerStatusSchema).optional()
});

export const userMessagePayloadSchema = z.object({
  messageId: messageIdSchema,
  text: z.string()
});

export const agentErrorPayloadSchema = z.object({
  messageId: messageIdSchema.optional(),
  agentName: z.string().optional(),
  code: z.string().optional(),
  message: z.string()
});

export const agentTokenPayloadSchema = z.object({
  messageId: messageIdSchema,
  agentName: z.string().optional(),
  externalAgentSessionId: externalAgentSessionIdSchema.optional(),
  deliveryId: nativeAgentDeliveryIdSchema.optional(),
  delta: z.string(),
  index: z.number().int().nonnegative(),
  source: z.enum(['managed-external-agent', 'external-agent-provider']).optional()
});

export const agentReasoningPayloadSchema = z.object({
  messageId: messageIdSchema,
  externalAgentSessionId: externalAgentSessionIdSchema.optional(),
  deliveryId: nativeAgentDeliveryIdSchema.optional(),
  delta: z.string(),
  index: z.number().int().nonnegative(),
  source: z.enum(['managed-external-agent', 'external-agent-provider']).optional()
});

export const agentMessagePayloadSchema = z.object({
  messageId: messageIdSchema,
  agentName: z.string().optional(),
  externalAgentSessionId: externalAgentSessionIdSchema.optional(),
  deliveryId: nativeAgentDeliveryIdSchema.optional(),
  text: z.string(),
  data: z.unknown().optional(),
  // File references shared with the message — lets live UI projections render the attachment
  // chips without reloading the persisted message row.
  attachments: z.array(messageAttachmentRefSchema).optional(),
  source: z.enum(['managed-external-agent', 'external-agent-provider']).optional(),
  usage: tokenUsageSchema.optional(),
  cost: costSchema.optional(),
  finishReason: finishReasonSchema.optional()
});

export const messageDeltaPayloadSchema = z.object({
  messageId: messageIdSchema,
  channel: z.string(),
  type: messageTypeSchema,
  delta: z.string(),
  index: z.number().int().nonnegative()
});

export const messageCompletePayloadSchema = z.object({
  messageId: messageIdSchema,
  channel: z.string(),
  type: messageTypeSchema,
  ok: z.boolean(),
  text: z.string(),
  data: z.unknown().optional()
});

export const toolCalledPayloadSchema = z.object({
  toolCallId: z.string(),
  tool: z.string(),
  input: z.unknown()
});

export const toolResultPayloadSchema = z.object({
  toolCallId: z.string(),
  tool: z.string(),
  ok: z.boolean(),
  result: z.string(),
  displayResult: z.string().optional(),
  display: z.unknown().optional(),
  // Machine-readable failure classification (e.g. 'PROCESS_NOT_FOUND') for tools whose failures a
  // client wants to branch on, distinct from the free-text `result` shown to the user.
  errorCode: z.string().optional()
});

export const toolProgressPayloadSchema = z.object({
  toolCallId: z.string(),
  tool: z.string(),
  output: z.string()
});

export const toolApprovalRequestedPayloadSchema = z.object({
  requestId: requestIdSchema,
  tool: z.string(),
  input: z.unknown(),
  // Gate pattern key (Tool.gateKey), when set. `host-control` marks a desktop-control action so the
  // UI can label it ("controlling your computer") and default the grant to session scope.
  key: z.string().optional()
});

export const toolApprovalResolvedPayloadSchema = z.object({
  requestId: requestIdSchema,
  tool: z.string(),
  allow: z.boolean(),
  reason: z.string().optional()
});

export const clarifyRequestedPayloadSchema = z.object({
  requestId: requestIdSchema,
  question: z.string(),
  options: z.array(z.string()).optional(),
  mode: clarifyChoiceModeSchema.optional(),
  allowOther: z.boolean().optional(),
  asker: clarifyAskerSchema.optional()
});

export const clarifyResolvedPayloadSchema = z.object({
  requestId: requestIdSchema,
  answer: z.string(),
  reason: z.string().optional()
});

export const contextSegmentSchema = z.object({
  category: z.enum(['systemPrompt', 'systemTools', 'mcpTools', 'memory', 'skills', 'customAgents', 'messages']),
  label: z.string(),
  tokens: z.number().int().nonnegative()
});

export const contextUsagePayloadSchema = z.object({
  contextLimit: z.number().int().positive(),
  used: z.number().int().nonnegative(),
  free: z.number().int().nonnegative(),
  autocompactBuffer: z.number().int().nonnegative(),
  approximate: z.boolean(),
  segments: z.array(contextSegmentSchema),
  /** Cumulative tokens reclaimed by lossless tool-result eviction so far this session. Informational
   *  only — NOT part of `segments`/`used` (those already reflect the post-eviction, shrunk prompt;
   *  adding this on top would double-count space that's already been freed). */
  reclaimed: z.number().int().nonnegative().optional()
});

// Publish-only, never persisted (like the session.stream_started/ended markers): fires the moment
// ToolResultEvictionContext actually reclaims space, so a client can show a transient "freed ~62K
// clearing 7 tool results" notice without it becoming a permanent transcript row.
export const contextEvictedPayloadSchema = z.object({
  reclaimedTokens: z.number().int().positive(),
  resultCount: z.number().int().positive()
});

// Publish-only, never persisted: fired at a task boundary (a turn just settled — no tool call is
// mid-flight) once window occupancy crosses `context.handoffNudge.atFraction`. A client can offer a
// one-click fresh session (reusing the existing `handoff` command/HANDOFF_PROMPT) instead of letting
// the user run into a hard truncation later. Refires every qualifying turn while still over the
// fraction — the client decides whether/how long to keep showing it.
export const contextHandoffSuggestedPayloadSchema = z.object({
  usedFraction: z.number().min(0),
  atFraction: z.number().min(0).max(1)
});

const fsOpSchema = z.enum(['read', 'write']);

export const delegationFsRequestPayloadSchema = z.object({
  requestId: requestIdSchema,
  op: fsOpSchema,
  path: z.string(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
  content: z.string().optional()
});

export const delegationTerminalRequestPayloadSchema = z.object({
  requestId: requestIdSchema,
  command: z.union([z.string(), z.array(z.string())]),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().optional()
});

export const externalAgentStartedPayloadSchema = z.object({
  externalAgentSessionId: z.string(),
  agentName: z.string(),
  provider: externalAgentProviderSchema,
  productIcon: externalAgentProductIconSchema.optional(),
  launchMode: externalAgentLaunchModeSchema,
  workingPath: z.string(),
  pid: z.number().int().nullable()
});

export const externalAgentOutputPayloadSchema = z.object({
  externalAgentSessionId: z.string(),
  stream: z.enum(['stdout', 'stderr', 'pty']),
  chunk: z.string()
});

export const externalAgentConnectionRequiredPayloadSchema = z.object({
  externalAgentSessionId: z.string().optional(),
  agentName: z.string(),
  provider: externalAgentProviderSchema,
  code: z.string().optional(),
  reason: z.string(),
  reconnectIn: z.literal('studio')
});

export const externalAgentApprovalRequestedPayloadSchema = z.object({
  externalAgentSessionId: z.string(),
  provider: externalAgentProviderSchema,
  requestId: requestIdSchema,
  text: z.string(),
  data: z.unknown().optional()
});

export const externalAgentApprovalResolvedPayloadSchema = z.object({
  externalAgentSessionId: z.string(),
  provider: externalAgentProviderSchema,
  requestId: requestIdSchema,
  allow: z.boolean(),
  reason: z.string().optional()
});

export const externalAgentResumeFailedPayloadSchema = z.object({
  agentName: z.string(),
  provider: externalAgentProviderSchema,
  providerSessionRef: z.string(),
  code: z.string(),
  message: z.string(),
  fallback: z.literal('cold-start')
});

export const externalAgentExitedPayloadSchema = z.object({
  externalAgentSessionId: z.string(),
  exitCode: z.number().int().nullable(),
  state: z.enum(['exited', 'failed', 'stopped'])
});

export type SessionCreatedPayload = z.infer<typeof sessionCreatedPayloadSchema>;
export type SessionUpdatedPayload = z.infer<typeof sessionUpdatedPayloadSchema>;
export type SessionRestoredPayload = z.infer<typeof sessionRestoredPayloadSchema>;
export type SessionStreamStartedPayload = z.infer<typeof sessionStreamStartedPayloadSchema>;
export type SessionStreamEndedPayload = z.infer<typeof sessionStreamEndedPayloadSchema>;
export type McpStatusUpdatedPayload = z.infer<typeof mcpStatusUpdatedPayloadSchema>;
export type UserMessagePayload = z.infer<typeof userMessagePayloadSchema>;
export type AgentErrorPayload = z.infer<typeof agentErrorPayloadSchema>;
export type AgentTokenPayload = z.infer<typeof agentTokenPayloadSchema>;
export type AgentReasoningPayload = z.infer<typeof agentReasoningPayloadSchema>;
export type AgentMessagePayload = z.infer<typeof agentMessagePayloadSchema>;
export type MessageDeltaPayload = z.infer<typeof messageDeltaPayloadSchema>;
export type MessageCompletePayload = z.infer<typeof messageCompletePayloadSchema>;
export type ToolCalledPayload = z.infer<typeof toolCalledPayloadSchema>;
export type ToolResultPayload = z.infer<typeof toolResultPayloadSchema>;
export type ToolProgressPayload = z.infer<typeof toolProgressPayloadSchema>;
export type ToolApprovalRequestedPayload = z.infer<typeof toolApprovalRequestedPayloadSchema>;
export type ToolApprovalResolvedPayload = z.infer<typeof toolApprovalResolvedPayloadSchema>;
export type ClarifyRequestedPayload = z.infer<typeof clarifyRequestedPayloadSchema>;
export type ClarifyResolvedPayload = z.infer<typeof clarifyResolvedPayloadSchema>;
export type ContextUsagePayload = z.infer<typeof contextUsagePayloadSchema>;
export type ContextEvictedPayload = z.infer<typeof contextEvictedPayloadSchema>;
export type ContextHandoffSuggestedPayload = z.infer<typeof contextHandoffSuggestedPayloadSchema>;
export type DelegationFsRequestPayload = z.infer<typeof delegationFsRequestPayloadSchema>;
export type DelegationTerminalRequestPayload = z.infer<typeof delegationTerminalRequestPayloadSchema>;
export type ExternalAgentStartedPayload = z.infer<typeof externalAgentStartedPayloadSchema>;
export type ExternalAgentOutputPayload = z.infer<typeof externalAgentOutputPayloadSchema>;
export type ExternalAgentConnectionRequiredPayload = z.infer<typeof externalAgentConnectionRequiredPayloadSchema>;
export type ExternalAgentApprovalRequestedPayload = z.infer<typeof externalAgentApprovalRequestedPayloadSchema>;
export type ExternalAgentApprovalResolvedPayload = z.infer<typeof externalAgentApprovalResolvedPayloadSchema>;
export type ExternalAgentResumeFailedPayload = z.infer<typeof externalAgentResumeFailedPayloadSchema>;
export type ExternalAgentExitedPayload = z.infer<typeof externalAgentExitedPayloadSchema>;

export const EVENT_TABLE = {
  'session.created': sessionCreatedPayloadSchema,
  'session.updated': sessionUpdatedPayloadSchema,
  'session.deleted': sessionDeletedPayloadSchema,
  'session.restored': sessionRestoredPayloadSchema,
  'session.stream_started': sessionStreamStartedPayloadSchema,
  'session.stream_ended': sessionStreamEndedPayloadSchema,
  'task.created': taskCreatedPayloadSchema,
  'task.progress': taskProgressPayloadSchema,
  'task.completed': taskCompletedPayloadSchema,
  'task.failed': taskFailedPayloadSchema,
  'mcp.status_updated': mcpStatusUpdatedPayloadSchema,
  'user.message': userMessagePayloadSchema,
  'agent.message': agentMessagePayloadSchema,
  'agent.token': agentTokenPayloadSchema,
  'agent.reasoning': agentReasoningPayloadSchema,
  'agent.error': agentErrorPayloadSchema,
  'message.delta': messageDeltaPayloadSchema,
  'message.complete': messageCompletePayloadSchema,
  'tool.called': toolCalledPayloadSchema,
  'tool.result': toolResultPayloadSchema,
  'tool.progress': toolProgressPayloadSchema,
  'tool.approval_requested': toolApprovalRequestedPayloadSchema,
  'tool.approval_resolved': toolApprovalResolvedPayloadSchema,
  'clarify.requested': clarifyRequestedPayloadSchema,
  'clarify.resolved': clarifyResolvedPayloadSchema,
  'context.usage': contextUsagePayloadSchema,
  'context.evicted': contextEvictedPayloadSchema,
  'context.handoff_suggested': contextHandoffSuggestedPayloadSchema,
  'delegation.fs_request': delegationFsRequestPayloadSchema,
  'delegation.terminal_request': delegationTerminalRequestPayloadSchema,
  'external_agent.started': externalAgentStartedPayloadSchema,
  'external_agent.output': externalAgentOutputPayloadSchema,
  'external_agent.connection_required': externalAgentConnectionRequiredPayloadSchema,
  'external_agent.approval_requested': externalAgentApprovalRequestedPayloadSchema,
  'external_agent.approval_resolved': externalAgentApprovalResolvedPayloadSchema,
  'external_agent.resume_failed': externalAgentResumeFailedPayloadSchema,
  'external_agent.exited': externalAgentExitedPayloadSchema
} as const satisfies Record<EventType, z.ZodTypeAny>;

export type EventPayload<T extends EventType> = z.infer<(typeof EVENT_TABLE)[T]>;

/**
 * Parse and validate the raw `payload` of an event. Returns a typed payload on
 * success; throws a ZodError on failure. Use in dev/test hot paths to catch
 * malformed events at the publish site.
 */
export function parseEventPayload<T extends EventType>(type: T, payload: Record<string, unknown>): EventPayload<T> {
  return EVENT_TABLE[type].parse(payload) as EventPayload<T>;
}

/**
 * In development, assert that a payload matches its event schema. No-op in
 * production (dead-code-eliminated by the bundler). Placed at publish sites so
 * mismatches surface in dev/CI rather than silently reaching clients.
 */
export function assertEventPayload<T extends EventType>(type: T, payload: Record<string, unknown>): void {
  if (Bun.env.NODE_ENV !== 'production') {
    EVENT_TABLE[type].parse(payload);
  }
}
