import { z } from 'zod';

import { sessionIdSchema } from '../ids.ts';
import { cursorPaginationQuerySchema, cursorPaginationResponseSchema } from '../pagination.ts';
import {
  externalAgentApprovalOwnershipSchema,
  externalAgentLaunchModeSchema,
  externalAgentNameSchema,
  externalAgentPresetSchema,
  externalAgentProductIconSchema,
  externalAgentProviderSchema,
  externalAgentRuntimeRoleSchema,
  externalAgentViewSchema
} from './external-agent-config.ts';
import { externalAgentObservationEventSchema } from './external-agent-observation.ts';
import { absolutePathSchema } from './external-agent-paths.ts';

export const externalAgentSessionStateSchema = z.enum(['starting', 'running', 'exited', 'failed', 'stopped']);
export type ExternalAgentSessionState = z.infer<typeof externalAgentSessionStateSchema>;

export const externalAgentAuthStateSchema = z.enum(['authenticated', 'unauthenticated', 'unknown']);
export type ExternalAgentAuthState = z.infer<typeof externalAgentAuthStateSchema>;

export const externalAgentUsageRecordSchema = z.object({
  name: z.string().min(1),
  resetAt: z.string().optional(),
  max: z.number().finite().optional(),
  current: z.number().finite()
});
export type ExternalAgentUsageRecord = z.infer<typeof externalAgentUsageRecordSchema>;

export const externalAgentUsageResponseSchema = z.object({
  agentName: z.string(),
  provider: externalAgentProviderSchema,
  checkedAt: z.string(),
  records: z.array(externalAgentUsageRecordSchema)
});
export type ExternalAgentUsageResponse = z.infer<typeof externalAgentUsageResponseSchema>;

export const externalAgentAuthSessionViewSchema = z.object({
  id: z.string().regex(/^ncliauth_/),
  controlToken: z.string().min(32),
  agentName: z.string(),
  provider: externalAgentProviderSchema,
  productIcon: externalAgentProductIconSchema.optional(),
  approvalOwnership: externalAgentApprovalOwnershipSchema.default('provider-owned'),
  authState: externalAgentAuthStateSchema.default('unknown'),
  state: externalAgentSessionStateSchema,
  pid: z.number().int().nullable(),
  outputSnapshot: z.string().default(''),
  exitCode: z.number().int().nullable(),
  startedAt: z.string(),
  updatedAt: z.string(),
  exitedAt: z.string().nullable()
});
export type ExternalAgentAuthSessionView = z.infer<typeof externalAgentAuthSessionViewSchema>;

export const externalAgentSessionViewSchema = z.object({
  id: z.string().regex(/^exa_/),
  sessionId: sessionIdSchema,
  agentName: z.string(),
  provider: externalAgentProviderSchema,
  productIcon: externalAgentProductIconSchema.optional(),
  workingPath: z.string(),
  launchMode: externalAgentLaunchModeSchema,
  approvalOwnership: externalAgentApprovalOwnershipSchema.default('provider-owned'),
  runtimeRole: externalAgentRuntimeRoleSchema.default('interactive'),
  agentRuntimeId: z.string().nullable().optional(),
  lastDeliveredSeq: z.number().int().nonnegative().default(0),
  lastVisibleSeq: z.number().int().nonnegative().default(0),
  pendingApprovalCount: z.number().int().nonnegative().default(0),
  state: externalAgentSessionStateSchema,
  pid: z.number().int().nullable(),
  providerSessionRef: z.string().nullable().optional(),
  outputSnapshot: z.string().default(''),
  exitCode: z.number().int().nullable(),
  startedAt: z.string(),
  updatedAt: z.string(),
  exitedAt: z.string().nullable()
});
export type ExternalAgentSessionView = z.infer<typeof externalAgentSessionViewSchema>;

export const nativeAgentRuntimeStateSchema = externalAgentSessionStateSchema;
export type NativeAgentRuntimeState = z.infer<typeof nativeAgentRuntimeStateSchema>;

export const nativeAgentSessionPointerSchema = z.object({
  providerSessionRef: z.string().nullable().optional()
});
export type NativeAgentSessionPointer = z.infer<typeof nativeAgentSessionPointerSchema>;

export const nativeAgentRuntimeSchema = z.object({
  id: z.string().regex(/^exa_/),
  sessionId: sessionIdSchema,
  agentName: z.string(),
  provider: externalAgentProviderSchema,
  productIcon: externalAgentProductIconSchema.optional(),
  workingPath: z.string(),
  launchMode: externalAgentLaunchModeSchema,
  approvalOwnership: externalAgentApprovalOwnershipSchema.default('provider-owned'),
  runtimeRole: externalAgentRuntimeRoleSchema.default('interactive'),
  agentRuntimeId: z.string().nullable().optional(),
  state: nativeAgentRuntimeStateSchema,
  session: nativeAgentSessionPointerSchema.default({}),
  lastDeliveredSeq: z.number().int().nonnegative().default(0),
  lastVisibleSeq: z.number().int().nonnegative().default(0),
  pendingApprovalCount: z.number().int().nonnegative().default(0),
  startedAt: z.string(),
  updatedAt: z.string(),
  exitedAt: z.string().nullable()
});
export type NativeAgentRuntime = z.infer<typeof nativeAgentRuntimeSchema>;

export const listExternalAgentsResponseSchema = z.object({ agents: z.array(externalAgentViewSchema) });
export type ListExternalAgentsResponse = z.infer<typeof listExternalAgentsResponseSchema>;

export const getExternalAgentResponseSchema = z.object({ agent: externalAgentViewSchema });
export type GetExternalAgentResponse = z.infer<typeof getExternalAgentResponseSchema>;

export const listExternalAgentPresetsResponseSchema = z.object({ presets: z.array(externalAgentPresetSchema) });
export type ListExternalAgentPresetsResponse = z.infer<typeof listExternalAgentPresetsResponseSchema>;

export const upsertExternalAgentRequestSchema = z.object({ agent: externalAgentViewSchema });
export type UpsertExternalAgentRequest = z.infer<typeof upsertExternalAgentRequestSchema>;

export const startExternalAgentRequestSchema = z.object({
  agentName: externalAgentNameSchema,
  workingPath: absolutePathSchema,
  launchMode: externalAgentLaunchModeSchema.optional(),
  runtimeRole: externalAgentRuntimeRoleSchema.optional(),
  providerSessionRef: z.string().min(1).optional()
});
export type StartExternalAgentRequest = z.infer<typeof startExternalAgentRequestSchema>;

export const startExternalAgentResponseSchema = z.object({ session: externalAgentSessionViewSchema });
export type StartExternalAgentResponse = z.infer<typeof startExternalAgentResponseSchema>;

export const getExternalAgentSessionResponseSchema = z.object({ session: externalAgentSessionViewSchema });
export type GetExternalAgentSessionResponse = z.infer<typeof getExternalAgentSessionResponseSchema>;

export const listExternalAgentSessionsResponseSchema = z.object({ sessions: z.array(externalAgentSessionViewSchema) });
export type ListExternalAgentSessionsResponse = z.infer<typeof listExternalAgentSessionsResponseSchema>;

export const listExternalAgentRuntimesQuerySchema = cursorPaginationQuerySchema;
export type ListExternalAgentRuntimesQuery = z.infer<typeof listExternalAgentRuntimesQuerySchema>;

export const listExternalAgentRuntimesResponseSchema = cursorPaginationResponseSchema.extend({
  sessions: z.array(externalAgentSessionViewSchema)
});
export type ListExternalAgentRuntimesResponse = z.infer<typeof listExternalAgentRuntimesResponseSchema>;

export const startExternalAgentAuthResponseSchema = z.object({ session: externalAgentAuthSessionViewSchema });
export type StartExternalAgentAuthResponse = z.infer<typeof startExternalAgentAuthResponseSchema>;

export const getExternalAgentAuthSessionResponseSchema = z.object({ session: externalAgentAuthSessionViewSchema });
export type GetExternalAgentAuthSessionResponse = z.infer<typeof getExternalAgentAuthSessionResponseSchema>;

export const externalAgentAuthStatusResponseSchema = z.object({
  agentName: z.string(),
  provider: externalAgentProviderSchema,
  state: externalAgentAuthStateSchema,
  output: z.string().default(''),
  checkedAt: z.string()
});
export type ExternalAgentAuthStatusResponse = z.infer<typeof externalAgentAuthStatusResponseSchema>;

export const externalAgentHistoryPageRequestSchema = cursorPaginationQuerySchema.extend({
  limit: z.coerce.number().int().positive().max(100).default(20),
  sortDirection: z.enum(['asc', 'desc']).default('desc'),
  itemsView: z.enum(['summary', 'full']).default('summary')
});
export type ExternalAgentHistoryPageRequest = z.infer<typeof externalAgentHistoryPageRequestSchema>;

export const externalAgentHistoryPageResponseSchema = cursorPaginationResponseSchema.extend({
  // Server-normalized cards, produced by the same provider adapter the daemon already uses for
  // parseOutput/historyPageOutput (the daemon knows the session's provider unambiguously — the client
  // must not re-derive it). No separate raw-items array: each event's `raw` already carries its
  // source record(s) (a single record, or an array when several records merged into one card).
  events: z.array(externalAgentObservationEventSchema)
});
export type ExternalAgentHistoryPageResponse = z.infer<typeof externalAgentHistoryPageResponseSchema>;

export const externalAgentInputRequestSchema = z.object({ input: z.string() });
export type ExternalAgentInputRequest = z.infer<typeof externalAgentInputRequestSchema>;

export const externalAgentResizeRequestSchema = z.object({
  cols: z.number().int().positive(),
  rows: z.number().int().positive()
});
export type ExternalAgentResizeRequest = z.infer<typeof externalAgentResizeRequestSchema>;

export const externalAgentApprovalResolutionRequestSchema = z.object({
  requestId: z.string().min(1),
  allow: z.boolean(),
  reason: z.string().optional()
});
export type ExternalAgentApprovalResolutionRequest = z.infer<typeof externalAgentApprovalResolutionRequestSchema>;
