import { z } from 'zod';

import { clarifyAskerSchema, clarifyChoiceModeSchema } from './clarify.ts';
import { contextUsagePayloadSchema } from './event-table.ts';
import { eventIdSchema, externalAgentSessionIdSchema, messageIdSchema, nativeAgentDeliveryIdSchema } from './ids.ts';
import { resourceApprovalDisplaySchema } from './resource-approval.ts';
import { listMessagesQuerySchema } from './rpc/control.ts';

export const uiMessageRoleSchema = z.enum(['user', 'assistant']);
export type UIMessageRole = z.infer<typeof uiMessageRoleSchema>;

export const uiItemStatusSchema = z.enum(['streaming', 'done', 'error']);
export type UIItemStatus = z.infer<typeof uiItemStatusSchema>;

export const uiTextPartSchema = z.object({
  type: z.literal('text'),
  text: z.string()
});
export type UITextPart = z.infer<typeof uiTextPartSchema>;

export const uiReasoningPartSchema = z.object({
  type: z.literal('reasoning'),
  text: z.string()
});
export type UIReasoningPart = z.infer<typeof uiReasoningPartSchema>;

export const uiArtifactPartSchema = z.object({
  type: z.literal('artifact'),
  messageType: z.string(),
  text: z.string().optional(),
  data: z.unknown().optional()
});
export type UIArtifactPart = z.infer<typeof uiArtifactPartSchema>;

export const uiCustomPartSchema = z.object({
  type: z.literal('custom'),
  name: z.string(),
  data: z.unknown().optional()
});
export type UICustomPart = z.infer<typeof uiCustomPartSchema>;

export const uiPartSchema = z.discriminatedUnion('type', [
  uiTextPartSchema,
  uiReasoningPartSchema,
  uiArtifactPartSchema,
  uiCustomPartSchema
]);
export type UIPart = z.infer<typeof uiPartSchema>;

export const uiMessageItemSchema = z.object({
  kind: z.literal('message'),
  id: z.string(),
  role: uiMessageRoleSchema,
  agentName: z.string().optional(),
  agentDisplayName: z.string().optional(),
  source: z.enum(['managed-external-agent', 'external-agent-provider']).optional(),
  externalAgentSessionId: externalAgentSessionIdSchema.optional(),
  deliveryId: nativeAgentDeliveryIdSchema.optional(),
  parts: z.array(uiPartSchema),
  status: uiItemStatusSchema.optional(),
  seq: z.string()
});
export type UIMessageItem = z.infer<typeof uiMessageItemSchema>;

export const uiToolItemSchema = z.object({
  kind: z.literal('tool'),
  id: z.string(),
  tool: z.string(),
  input: z.unknown().optional(),
  output: z.string().optional(),
  display: z.unknown().optional(),
  status: z.enum(['running', 'ok', 'error']),
  errorCode: z.string().optional(),
  seq: z.string()
});
export type UIToolItem = z.infer<typeof uiToolItemSchema>;

export const uiApprovalDisplaySchema = z.discriminatedUnion('kind', [resourceApprovalDisplaySchema]);
export type UIApprovalDisplay = z.infer<typeof uiApprovalDisplaySchema>;

export const uiApprovalItemSchema = z.object({
  kind: z.literal('approval'),
  id: z.string(),
  tool: z.string(),
  input: z.unknown().optional(),
  display: uiApprovalDisplaySchema.optional(),
  key: z.string().optional(),
  seq: z.string()
});
export type UIApprovalItem = z.infer<typeof uiApprovalItemSchema>;

export const uiClarificationItemSchema = z.object({
  kind: z.literal('clarification'),
  id: z.string(),
  question: z.string(),
  options: z.array(z.string()).optional(),
  mode: clarifyChoiceModeSchema.optional(),
  allowOther: z.boolean().optional(),
  asker: clarifyAskerSchema.optional(),
  seq: z.string()
});
export type UIClarificationItem = z.infer<typeof uiClarificationItemSchema>;

export const uiContextItemSchema = z.object({
  kind: z.literal('context'),
  id: z.literal('context'),
  usage: contextUsagePayloadSchema,
  seq: z.string()
});
export type UIContextItem = z.infer<typeof uiContextItemSchema>;

export const uiMemorySummaryItemSchema = z.object({
  kind: z.literal('memory_summary'),
  id: z.string(),
  summary: z.string(),
  uptoMessageId: z.string(),
  seq: z.string()
});
export type UIMemorySummaryItem = z.infer<typeof uiMemorySummaryItemSchema>;

export const uiSystemItemSchema = z.object({
  kind: z.literal('system'),
  id: z.string(),
  text: z.string(),
  level: z.enum(['info', 'warn', 'error']).optional(),
  seq: z.string()
});
export type UISystemItem = z.infer<typeof uiSystemItemSchema>;

export const uiCustomItemSchema = z.object({
  kind: z.literal('custom'),
  id: z.string(),
  name: z.string(),
  data: z.unknown().optional(),
  status: uiItemStatusSchema.optional(),
  seq: z.string()
});
export type UICustomItem = z.infer<typeof uiCustomItemSchema>;

export const uiItemSchema = z.discriminatedUnion('kind', [
  uiMessageItemSchema,
  uiToolItemSchema,
  uiApprovalItemSchema,
  uiClarificationItemSchema,
  uiContextItemSchema,
  uiMemorySummaryItemSchema,
  uiSystemItemSchema,
  uiCustomItemSchema
]);
export type UIItem = z.infer<typeof uiItemSchema>;

// `before` pages toward older messages; `after` pages toward newer ones (history mode
// scrolling down from a deep-linked middle); `around` opens an inclusive window centred on a
// message (deep-link / search-to-message). At most one is set per request. An empty string
// (how a query serializer may encode an omitted param) is coerced to absent.
const optionalCursor = z.preprocess((v) => (v === '' ? undefined : v), messageIdSchema.optional());
export const listUiItemsQuerySchema = listMessagesQuerySchema.extend({
  before: optionalCursor,
  after: optionalCursor,
  around: optionalCursor
});
export type ListUiItemsQuery = z.infer<typeof listUiItemsQuerySchema>;

export const listUiItemsResponseSchema = z.object({
  items: z.array(uiItemSchema),
  /** Oldest message id of this page — the `before` cursor for the next older page. Absent at the top. */
  olderCursor: messageIdSchema.optional(),
  /** Newest message id of this page — the `after` cursor for the next newer page. Absent at the tail. */
  newerCursor: messageIdSchema.optional()
});
export type ListUiItemsResponse = z.infer<typeof listUiItemsResponseSchema>;

export const uiRemovalTargetSchema = z.object({
  kind: z.enum(['message', 'approval', 'clarification', 'custom', 'tool']),
  id: z.string()
});
export type UIRemovalTarget = z.infer<typeof uiRemovalTargetSchema>;

export const uiSnapshotEventSchema = z.object({
  kind: z.literal('snapshot'),
  cursor: eventIdSchema.optional(),
  items: z.array(uiItemSchema),
  /** Oldest message id in this (bounded) snapshot — the `before` cursor for loading older history. */
  oldestCursor: messageIdSchema.optional(),
  /** True when older messages exist before `oldestCursor` (the snapshot is windowed, not the full transcript). */
  hasMore: z.boolean().optional(),
  /** True when this snapshot supersedes all prior transcript windows after a restore or reset. */
  replacesTranscript: z.boolean().optional()
});
export type UISnapshotEvent = z.infer<typeof uiSnapshotEventSchema>;

export const uiUpsertEventSchema = z.object({
  kind: z.literal('upsert'),
  cursor: eventIdSchema.optional(),
  item: uiItemSchema
});
export type UIUpsertEvent = z.infer<typeof uiUpsertEventSchema>;

export const uiRemoveEventSchema = z.object({
  kind: z.literal('remove'),
  cursor: eventIdSchema.optional(),
  target: uiRemovalTargetSchema
});
export type UIRemoveEvent = z.infer<typeof uiRemoveEventSchema>;

export const sessionUiEventSchema = z.discriminatedUnion('kind', [
  uiSnapshotEventSchema,
  uiUpsertEventSchema,
  uiRemoveEventSchema
]);
export type SessionUiEvent = z.infer<typeof sessionUiEventSchema>;
