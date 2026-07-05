import { z } from 'zod';

import { transcriptTargetIdSchema } from './ids.ts';
import {
  nativeCliAgentNameSchema,
  nativeCliAgentPresetSchema,
  nativeCliAgentViewSchema,
  nativeCliApprovalOwnershipSchema,
  nativeCliLaunchModeSchema,
  nativeCliProductIconSchema,
  nativeCliProviderSchema,
  nativeCliRuntimeRoleSchema
} from './native-cli-agent-config.ts';
import { absolutePathSchema } from './native-cli-agent-paths.ts';

export const nativeCliSessionStateSchema = z.enum(['starting', 'running', 'exited', 'failed', 'stopped']);
export type NativeCliSessionState = z.infer<typeof nativeCliSessionStateSchema>;

export const nativeCliAuthStateSchema = z.enum(['authenticated', 'unauthenticated', 'unknown']);
export type NativeCliAuthState = z.infer<typeof nativeCliAuthStateSchema>;

export const nativeCliUsageRecordSchema = z.object({
  category: z.string().min(1),
  resetAt: z.string().nullable(),
  max: z.number().finite().nullable(),
  current: z.number().finite().nullable()
});
export type NativeCliUsageRecord = z.infer<typeof nativeCliUsageRecordSchema>;

export const nativeCliUsageResponseSchema = z.object({
  agentName: z.string(),
  provider: nativeCliProviderSchema,
  checkedAt: z.string(),
  records: z.array(nativeCliUsageRecordSchema)
});
export type NativeCliUsageResponse = z.infer<typeof nativeCliUsageResponseSchema>;

export const nativeCliAuthSessionViewSchema = z.object({
  id: z.string().regex(/^ncliauth_/),
  controlToken: z.string().min(32),
  agentName: z.string(),
  provider: nativeCliProviderSchema,
  productIcon: nativeCliProductIconSchema.optional(),
  approvalOwnership: nativeCliApprovalOwnershipSchema.default('provider-owned'),
  authState: nativeCliAuthStateSchema.default('unknown'),
  state: nativeCliSessionStateSchema,
  pid: z.number().int().nullable(),
  outputSnapshot: z.string().default(''),
  exitCode: z.number().int().nullable(),
  startedAt: z.string(),
  updatedAt: z.string(),
  exitedAt: z.string().nullable()
});
export type NativeCliAuthSessionView = z.infer<typeof nativeCliAuthSessionViewSchema>;

export const nativeCliSessionViewSchema = z.object({
  id: z.string().regex(/^ncli_/),
  transcriptTargetId: transcriptTargetIdSchema,
  agentName: z.string(),
  provider: nativeCliProviderSchema,
  productIcon: nativeCliProductIconSchema.optional(),
  workingPath: z.string(),
  launchMode: nativeCliLaunchModeSchema,
  approvalOwnership: nativeCliApprovalOwnershipSchema.default('provider-owned'),
  runtimeRole: nativeCliRuntimeRoleSchema.default('interactive'),
  agentRuntimeId: z.string().nullable().optional(),
  lastDeliveredSeq: z.number().int().nonnegative().default(0),
  lastVisibleSeq: z.number().int().nonnegative().default(0),
  pendingApprovalCount: z.number().int().nonnegative().default(0),
  state: nativeCliSessionStateSchema,
  pid: z.number().int().nullable(),
  providerSessionRef: z.string().nullable().optional(),
  outputSnapshot: z.string().default(''),
  exitCode: z.number().int().nullable(),
  startedAt: z.string(),
  updatedAt: z.string(),
  exitedAt: z.string().nullable()
});
export type NativeCliSessionView = z.infer<typeof nativeCliSessionViewSchema>;

export const nativeAgentRuntimeStateSchema = nativeCliSessionStateSchema;
export type NativeAgentRuntimeState = z.infer<typeof nativeAgentRuntimeStateSchema>;

export const nativeAgentSessionPointerSchema = z.object({
  providerSessionRef: z.string().nullable().optional()
});
export type NativeAgentSessionPointer = z.infer<typeof nativeAgentSessionPointerSchema>;

export const nativeAgentRuntimeSchema = z.object({
  id: z.string().regex(/^ncli_/),
  transcriptTargetId: transcriptTargetIdSchema,
  agentName: z.string(),
  provider: nativeCliProviderSchema,
  productIcon: nativeCliProductIconSchema.optional(),
  workingPath: z.string(),
  launchMode: nativeCliLaunchModeSchema,
  approvalOwnership: nativeCliApprovalOwnershipSchema.default('provider-owned'),
  runtimeRole: nativeCliRuntimeRoleSchema.default('interactive'),
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

export const listNativeCliAgentsResponseSchema = z.object({ agents: z.array(nativeCliAgentViewSchema) });
export type ListNativeCliAgentsResponse = z.infer<typeof listNativeCliAgentsResponseSchema>;

export const listNativeCliAgentPresetsResponseSchema = z.object({ presets: z.array(nativeCliAgentPresetSchema) });
export type ListNativeCliAgentPresetsResponse = z.infer<typeof listNativeCliAgentPresetsResponseSchema>;

export const upsertNativeCliAgentRequestSchema = z.object({ agent: nativeCliAgentViewSchema });
export type UpsertNativeCliAgentRequest = z.infer<typeof upsertNativeCliAgentRequestSchema>;

export const startNativeCliAgentRequestSchema = z.object({
  agentName: nativeCliAgentNameSchema,
  workingPath: absolutePathSchema,
  launchMode: nativeCliLaunchModeSchema.optional(),
  runtimeRole: nativeCliRuntimeRoleSchema.optional(),
  providerSessionRef: z.string().min(1).optional()
});
export type StartNativeCliAgentRequest = z.infer<typeof startNativeCliAgentRequestSchema>;

export const startNativeCliAgentResponseSchema = z.object({ session: nativeCliSessionViewSchema });
export type StartNativeCliAgentResponse = z.infer<typeof startNativeCliAgentResponseSchema>;

export const getNativeCliSessionResponseSchema = z.object({ session: nativeCliSessionViewSchema });
export type GetNativeCliSessionResponse = z.infer<typeof getNativeCliSessionResponseSchema>;

export const listNativeCliSessionsResponseSchema = z.object({ sessions: z.array(nativeCliSessionViewSchema) });
export type ListNativeCliSessionsResponse = z.infer<typeof listNativeCliSessionsResponseSchema>;

export const startNativeCliAuthResponseSchema = z.object({ session: nativeCliAuthSessionViewSchema });
export type StartNativeCliAuthResponse = z.infer<typeof startNativeCliAuthResponseSchema>;

export const getNativeCliAuthSessionResponseSchema = z.object({ session: nativeCliAuthSessionViewSchema });
export type GetNativeCliAuthSessionResponse = z.infer<typeof getNativeCliAuthSessionResponseSchema>;

export const nativeCliAuthStatusResponseSchema = z.object({
  agentName: z.string(),
  provider: nativeCliProviderSchema,
  state: nativeCliAuthStateSchema,
  output: z.string().default(''),
  checkedAt: z.string()
});
export type NativeCliAuthStatusResponse = z.infer<typeof nativeCliAuthStatusResponseSchema>;

export const nativeCliHistoryPageRequestSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100).default(20),
  sortDirection: z.enum(['asc', 'desc']).default('desc'),
  itemsView: z.enum(['summary', 'full']).default('summary')
});
export type NativeCliHistoryPageRequest = z.infer<typeof nativeCliHistoryPageRequestSchema>;

export const nativeCliHistoryPageResponseSchema = z.object({
  page: z.object({
    items: z.array(z.unknown()),
    nextCursor: z.string().nullable(),
    backwardsCursor: z.string().nullable()
  })
});
export type NativeCliHistoryPageResponse = z.infer<typeof nativeCliHistoryPageResponseSchema>;

export const nativeCliInputRequestSchema = z.object({ input: z.string() });
export type NativeCliInputRequest = z.infer<typeof nativeCliInputRequestSchema>;

export const nativeCliResizeRequestSchema = z.object({
  cols: z.number().int().positive(),
  rows: z.number().int().positive()
});
export type NativeCliResizeRequest = z.infer<typeof nativeCliResizeRequestSchema>;

export const nativeCliApprovalResolutionRequestSchema = z.object({
  requestId: z.string().min(1),
  allow: z.boolean(),
  reason: z.string().optional()
});
export type NativeCliApprovalResolutionRequest = z.infer<typeof nativeCliApprovalResolutionRequestSchema>;
