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
import { chatMessageSchema, type EventType } from './domain.ts';
import { agentIdSchema, meshSessionIdSchema, messageIdSchema, transcriptTargetIdSchema } from './ids.ts';
import { mcpServerStatusSchema } from './mcp-server.ts';
import { memoryScopeSchema } from './memory.ts';
import {
  meshAgentIdleResumedSystemEventSchema,
  meshAgentIdleSuspendedSystemEventSchema,
  meshAgentProductIconSchema,
  meshAgentProviderSchema
} from './mesh-agent/index.ts';
import { messageProducerSchema } from './message-ingress.ts';

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

export const sessionRestoredPayloadSchema = z.object({
  toMessageId: messageIdSchema,
  restoredCount: z.number().int().nonnegative(),
  newHeadMessageId: messageIdSchema.nullable()
});

const transcriptEventIdentitySchema = z.object({
  transcriptTargetId: transcriptTargetIdSchema
});

const messageEventIdentitySchema = transcriptEventIdentitySchema.extend({
  producer: messageProducerSchema
});

const messageRevisionSchema = z.number().int().nonnegative();

const durableMessagePayloadSchema = messageEventIdentitySchema.extend({
  message: chatMessageSchema,
  messageRevision: messageRevisionSchema
});

export const sessionMessageCreatedPayloadSchema = durableMessagePayloadSchema;
export const sessionMessageUpdatedPayloadSchema = durableMessagePayloadSchema;
export const sessionMessageCompletedPayloadSchema = durableMessagePayloadSchema;
export const sessionMessageFailedPayloadSchema = durableMessagePayloadSchema;

export const sessionMessageDeletedPayloadSchema = messageEventIdentitySchema.extend({
  messageId: messageIdSchema,
  messageRevision: messageRevisionSchema
});

export const sessionMessageDeltaAppendedPayloadSchema = messageEventIdentitySchema.extend({
  messageId: messageIdSchema,
  channel: z.string().min(1),
  index: z.number().int().nonnegative(),
  delta: z.string()
});

export const sessionRunStartedPayloadSchema = transcriptEventIdentitySchema;
export const sessionRunCompletedPayloadSchema = transcriptEventIdentitySchema;
export const sessionRunFailedPayloadSchema = transcriptEventIdentitySchema.extend({
  error: z.object({ code: z.string().min(1), message: z.string().min(1) })
});
export const sessionRunCancelledPayloadSchema = transcriptEventIdentitySchema.extend({
  reason: z.string().min(1).optional()
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

// Publish-only, never persisted: fires the moment
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

// Fired when memoryPromotion.mode is 'suggest': a span about to be compacted away yielded durable
// facts, offered to the user for confirmation rather than written automatically. Persisted (unlike
// the context.* transients above) — a suggestion the user hasn't acted on yet must survive a reload.
export const memorySuggestionPayloadSchema = z.object({
  scope: memoryScopeSchema,
  facts: z.array(z.string().min(1)).min(1)
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

export const meshAgentStartedPayloadSchema = z.object({
  meshSessionId: z.string(),
  agentName: z.string(),
  provider: meshAgentProviderSchema,
  productIcon: meshAgentProductIconSchema.optional(),
  workingPath: z.string(),
  pid: z.number().int().nullable()
});

const meshAgentConnectionIdentitySchema = z.object({
  meshSessionId: meshSessionIdSchema,
  provider: meshAgentProviderSchema,
  observationEpoch: z.string().min(1)
});

export const meshSessionConnectionOpenedPayloadSchema = meshAgentConnectionIdentitySchema;
export const meshSessionConnectionClosedPayloadSchema = meshAgentConnectionIdentitySchema.extend({
  reason: z.enum(['exited', 'failed', 'stopped', 'disconnected'])
});

export const meshAgentConnectionRequiredPayloadSchema = z.object({
  meshSessionId: z.string().optional(),
  agentName: z.string(),
  authAgentName: z.string().optional(),
  provider: meshAgentProviderSchema,
  code: z.string().optional(),
  reason: z.string(),
  reconnectIn: z.literal('studio')
});

export const meshAgentApprovalRequestedPayloadSchema = z.object({
  meshSessionId: z.string(),
  provider: meshAgentProviderSchema,
  requestId: requestIdSchema,
  text: z.string(),
  data: z.unknown().optional()
});

export const meshAgentApprovalResolvedPayloadSchema = z.object({
  meshSessionId: z.string(),
  provider: meshAgentProviderSchema,
  requestId: requestIdSchema,
  allow: z.boolean(),
  reason: z.string().optional()
});

export const meshAgentIdleSuspendedPayloadSchema = meshAgentIdleSuspendedSystemEventSchema;
export const meshAgentIdleResumedPayloadSchema = meshAgentIdleResumedSystemEventSchema;

export const meshAgentResumeFailedPayloadSchema = z.object({
  agentName: z.string(),
  provider: meshAgentProviderSchema,
  providerSessionRef: z.string(),
  code: z.string(),
  message: z.string(),
  fallback: z.literal('cold-start')
});

export const meshAgentExitedPayloadSchema = z.object({
  meshSessionId: z.string(),
  exitCode: z.number().int().nullable(),
  state: z.enum(['exited', 'failed', 'stopped'])
});

// The underlying provider process stays alive across turns for a managed-project/provider agent, so
// this signals "the current turn finished" without implying the process exited — distinct from
// mesh.exited, which is process lifecycle. Flips the live tool card off 'running' so
// presence projection (meshAgentIsGenerating) settles back to idle for notification-style
// completions that never streamed raw stdout/pty output.
export const meshAgentTurnSettledPayloadSchema = z.object({
  meshSessionId: z.string(),
  error: z.boolean().optional()
});

export const meshAgentLoginRequiredPayloadSchema = z.object({
  meshSessionId: z.string().optional(),
  agentName: z.string(),
  authAgentName: z.string().optional(),
  provider: meshAgentProviderSchema,
  reason: z.string()
});

export const meshAgentLoginResolvedPayloadSchema = z.object({
  agentName: z.string(),
  provider: meshAgentProviderSchema
});

export type SessionCreatedPayload = z.infer<typeof sessionCreatedPayloadSchema>;
export type SessionUpdatedPayload = z.infer<typeof sessionUpdatedPayloadSchema>;
export type SessionRestoredPayload = z.infer<typeof sessionRestoredPayloadSchema>;
export type McpStatusUpdatedPayload = z.infer<typeof mcpStatusUpdatedPayloadSchema>;
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
export type MemorySuggestionPayload = z.infer<typeof memorySuggestionPayloadSchema>;
export type DelegationFsRequestPayload = z.infer<typeof delegationFsRequestPayloadSchema>;
export type DelegationTerminalRequestPayload = z.infer<typeof delegationTerminalRequestPayloadSchema>;
export type MeshAgentStartedPayload = z.infer<typeof meshAgentStartedPayloadSchema>;
export type MeshAgentConnectionRequiredPayload = z.infer<typeof meshAgentConnectionRequiredPayloadSchema>;
export type MeshAgentApprovalRequestedPayload = z.infer<typeof meshAgentApprovalRequestedPayloadSchema>;
export type MeshAgentApprovalResolvedPayload = z.infer<typeof meshAgentApprovalResolvedPayloadSchema>;
export type MeshAgentIdleSuspendedPayload = z.infer<typeof meshAgentIdleSuspendedPayloadSchema>;
export type MeshAgentIdleResumedPayload = z.infer<typeof meshAgentIdleResumedPayloadSchema>;
export type MeshAgentResumeFailedPayload = z.infer<typeof meshAgentResumeFailedPayloadSchema>;
export type MeshAgentExitedPayload = z.infer<typeof meshAgentExitedPayloadSchema>;
export type MeshAgentTurnSettledPayload = z.infer<typeof meshAgentTurnSettledPayloadSchema>;
export type MeshAgentLoginRequiredPayload = z.infer<typeof meshAgentLoginRequiredPayloadSchema>;
export type MeshAgentLoginResolvedPayload = z.infer<typeof meshAgentLoginResolvedPayloadSchema>;

export type EventDelivery = 'control' | 'generation' | 'both';
export type EventPersistence = 'durable' | 'transient';

export interface EventDefinition<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  schema: TSchema;
  delivery: EventDelivery;
  persistence: EventPersistence;
}

function defineEvent<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  delivery: EventDelivery,
  persistence: EventPersistence
): EventDefinition<TSchema> {
  return { schema, delivery, persistence };
}

export const EVENT_DEFINITIONS = {
  'session.created': defineEvent(sessionCreatedPayloadSchema, 'control', 'durable'),
  'session.updated': defineEvent(sessionUpdatedPayloadSchema, 'control', 'durable'),
  'session.deleted': defineEvent(sessionDeletedPayloadSchema, 'control', 'durable'),
  'session.restored': defineEvent(sessionRestoredPayloadSchema, 'control', 'durable'),
  'session.run.started': defineEvent(sessionRunStartedPayloadSchema, 'control', 'transient'),
  'session.run.completed': defineEvent(sessionRunCompletedPayloadSchema, 'control', 'transient'),
  'session.run.failed': defineEvent(sessionRunFailedPayloadSchema, 'control', 'transient'),
  'session.run.cancelled': defineEvent(sessionRunCancelledPayloadSchema, 'control', 'transient'),
  'session.message.created': defineEvent(sessionMessageCreatedPayloadSchema, 'control', 'durable'),
  'session.message.updated': defineEvent(sessionMessageUpdatedPayloadSchema, 'control', 'durable'),
  'session.message.deleted': defineEvent(sessionMessageDeletedPayloadSchema, 'control', 'durable'),
  'session.message.delta.appended': defineEvent(sessionMessageDeltaAppendedPayloadSchema, 'generation', 'transient'),
  'session.message.completed': defineEvent(sessionMessageCompletedPayloadSchema, 'both', 'durable'),
  'session.message.failed': defineEvent(sessionMessageFailedPayloadSchema, 'both', 'durable'),
  'task.created': defineEvent(taskCreatedPayloadSchema, 'control', 'durable'),
  'task.progress': defineEvent(taskProgressPayloadSchema, 'control', 'durable'),
  'task.completed': defineEvent(taskCompletedPayloadSchema, 'control', 'durable'),
  'task.failed': defineEvent(taskFailedPayloadSchema, 'control', 'durable'),
  'mcp.status_updated': defineEvent(mcpStatusUpdatedPayloadSchema, 'control', 'transient'),
  'tool.called': defineEvent(toolCalledPayloadSchema, 'generation', 'durable'),
  'tool.result': defineEvent(toolResultPayloadSchema, 'generation', 'durable'),
  'tool.progress': defineEvent(toolProgressPayloadSchema, 'generation', 'transient'),
  'tool.approval_requested': defineEvent(toolApprovalRequestedPayloadSchema, 'generation', 'durable'),
  'tool.approval_resolved': defineEvent(toolApprovalResolvedPayloadSchema, 'generation', 'durable'),
  'clarify.requested': defineEvent(clarifyRequestedPayloadSchema, 'generation', 'durable'),
  'clarify.resolved': defineEvent(clarifyResolvedPayloadSchema, 'generation', 'durable'),
  'context.usage': defineEvent(contextUsagePayloadSchema, 'generation', 'transient'),
  'context.evicted': defineEvent(contextEvictedPayloadSchema, 'generation', 'transient'),
  'context.handoff_suggested': defineEvent(contextHandoffSuggestedPayloadSchema, 'generation', 'transient'),
  'memory.suggestion': defineEvent(memorySuggestionPayloadSchema, 'generation', 'durable'),
  'delegation.fs_request': defineEvent(delegationFsRequestPayloadSchema, 'generation', 'transient'),
  'delegation.terminal_request': defineEvent(delegationTerminalRequestPayloadSchema, 'generation', 'transient'),
  'mesh.started': defineEvent(meshAgentStartedPayloadSchema, 'both', 'durable'),
  'mesh.connection_required': defineEvent(meshAgentConnectionRequiredPayloadSchema, 'generation', 'transient'),
  'mesh.approval_requested': defineEvent(meshAgentApprovalRequestedPayloadSchema, 'generation', 'durable'),
  'mesh.approval_resolved': defineEvent(meshAgentApprovalResolvedPayloadSchema, 'generation', 'durable'),
  'mesh.idle_suspended': defineEvent(meshAgentIdleSuspendedPayloadSchema, 'generation', 'durable'),
  'mesh.idle_resumed': defineEvent(meshAgentIdleResumedPayloadSchema, 'generation', 'durable'),
  'mesh.resume_failed': defineEvent(meshAgentResumeFailedPayloadSchema, 'generation', 'durable'),
  'mesh.exited': defineEvent(meshAgentExitedPayloadSchema, 'both', 'durable'),
  'mesh.turn_settled': defineEvent(meshAgentTurnSettledPayloadSchema, 'generation', 'transient'),
  'mesh.session.connection.opened': defineEvent(meshSessionConnectionOpenedPayloadSchema, 'control', 'transient'),
  'mesh.session.connection.closed': defineEvent(meshSessionConnectionClosedPayloadSchema, 'control', 'transient'),
  'mesh.login_required': defineEvent(meshAgentLoginRequiredPayloadSchema, 'generation', 'transient'),
  'mesh.login_resolved': defineEvent(meshAgentLoginResolvedPayloadSchema, 'generation', 'transient')
} as const satisfies Record<EventType, EventDefinition>;

type EventDefinitions = typeof EVENT_DEFINITIONS;
type EventTable = {
  [T in keyof EventDefinitions]: EventDefinitions[T]['schema'];
};

export const EVENT_TABLE = Object.fromEntries(
  Object.entries(EVENT_DEFINITIONS).map(([type, definition]) => [type, definition.schema])
) as EventTable;

export function eventDefinition<T extends EventType>(type: T): EventDefinitions[T] {
  return EVENT_DEFINITIONS[type];
}

export type EventPayload<T extends EventType> = z.infer<EventDefinitions[T]['schema']>;

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
