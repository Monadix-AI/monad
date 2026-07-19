import { z } from 'zod';

import { meshAgentAuthSessionIdSchema, meshSessionIdSchema, sessionIdSchema } from '../ids.ts';
import { cursorPaginationQuerySchema, cursorPaginationResponseSchema } from '../pagination.ts';
import {
  meshAgentApprovalOwnershipSchema,
  meshAgentLaunchModeSchema,
  meshAgentNameSchema,
  meshAgentPresetSchema,
  meshAgentProductIconSchema,
  meshAgentProviderSchema,
  meshAgentRuntimeRoleSchema,
  meshAgentViewSchema
} from './mesh-agent-config.ts';
import { absolutePathSchema } from './mesh-agent-paths.ts';

export const meshSessionStateSchema = z.enum(['starting', 'running', 'exited', 'failed', 'stopped']);
export type MeshSessionState = z.infer<typeof meshSessionStateSchema>;

export const meshAgentAuthStateSchema = z.enum(['authenticated', 'unauthenticated', 'unknown']);
export type MeshAgentAuthState = z.infer<typeof meshAgentAuthStateSchema>;

export const meshAgentUsageRecordSchema = z.object({
  name: z.string().min(1),
  resetAt: z.string().optional(),
  max: z.number().finite().optional(),
  current: z.number().finite()
});
export type MeshAgentUsageRecord = z.infer<typeof meshAgentUsageRecordSchema>;

export const meshAgentUsageResponseSchema = z.object({
  agentName: z.string(),
  provider: meshAgentProviderSchema,
  checkedAt: z.string(),
  records: z.array(meshAgentUsageRecordSchema)
});
export type MeshAgentUsageResponse = z.infer<typeof meshAgentUsageResponseSchema>;

export const meshAgentAuthSessionViewSchema = z.object({
  id: meshAgentAuthSessionIdSchema,
  controlToken: z.string().min(32),
  agentName: z.string(),
  provider: meshAgentProviderSchema,
  productIcon: meshAgentProductIconSchema.optional(),
  approvalOwnership: meshAgentApprovalOwnershipSchema.default('provider-owned'),
  authState: meshAgentAuthStateSchema.default('unknown'),
  state: meshSessionStateSchema,
  pid: z.number().int().nullable(),
  outputSnapshot: z.string().default(''),
  exitCode: z.number().int().nullable(),
  startedAt: z.string(),
  updatedAt: z.string(),
  exitedAt: z.string().nullable()
});
export type MeshAgentAuthSessionView = z.infer<typeof meshAgentAuthSessionViewSchema>;

export const meshSessionViewSchema = z.object({
  id: meshSessionIdSchema,
  sessionId: sessionIdSchema,
  agentName: z.string(),
  provider: meshAgentProviderSchema,
  productIcon: meshAgentProductIconSchema.optional(),
  workingPath: z.string(),
  launchMode: meshAgentLaunchModeSchema,
  approvalOwnership: meshAgentApprovalOwnershipSchema.default('provider-owned'),
  runtimeRole: meshAgentRuntimeRoleSchema.default('interactive'),
  agentRuntimeId: z.string().nullable().optional(),
  lastDeliveredSeq: z.number().int().nonnegative().default(0),
  lastVisibleSeq: z.number().int().nonnegative().default(0),
  pendingApprovalCount: z.number().int().nonnegative().default(0),
  state: meshSessionStateSchema,
  pid: z.number().int().nullable(),
  providerSessionRef: z.string().nullable().optional(),
  outputSnapshot: z.string().default(''),
  exitCode: z.number().int().nullable(),
  startedAt: z.string(),
  updatedAt: z.string(),
  exitedAt: z.string().nullable()
});
export type MeshSessionView = z.infer<typeof meshSessionViewSchema>;

export const nativeAgentRuntimeStateSchema = meshSessionStateSchema;
export type NativeAgentRuntimeState = z.infer<typeof nativeAgentRuntimeStateSchema>;

export const nativeAgentSessionPointerSchema = z.object({
  providerSessionRef: z.string().nullable().optional()
});
export type NativeAgentSessionPointer = z.infer<typeof nativeAgentSessionPointerSchema>;

export const nativeAgentRuntimeSchema = z.object({
  id: meshSessionIdSchema,
  sessionId: sessionIdSchema,
  agentName: z.string(),
  provider: meshAgentProviderSchema,
  productIcon: meshAgentProductIconSchema.optional(),
  workingPath: z.string(),
  launchMode: meshAgentLaunchModeSchema,
  approvalOwnership: meshAgentApprovalOwnershipSchema.default('provider-owned'),
  runtimeRole: meshAgentRuntimeRoleSchema.default('interactive'),
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

export const listMeshAgentsResponseSchema = z.object({ agents: z.array(meshAgentViewSchema) });
export type ListMeshAgentsResponse = z.infer<typeof listMeshAgentsResponseSchema>;

export const getMeshAgentResponseSchema = z.object({ agent: meshAgentViewSchema });
export type GetMeshAgentResponse = z.infer<typeof getMeshAgentResponseSchema>;

export const listMeshAgentPresetsResponseSchema = z.object({ presets: z.array(meshAgentPresetSchema) });
export type ListMeshAgentPresetsResponse = z.infer<typeof listMeshAgentPresetsResponseSchema>;

export const upsertMeshAgentRequestSchema = z.object({ agent: meshAgentViewSchema });
export type UpsertMeshAgentRequest = z.infer<typeof upsertMeshAgentRequestSchema>;

export const startMeshAgentRequestSchema = z.object({
  transcriptTargetId: sessionIdSchema,
  agentName: meshAgentNameSchema,
  workingPath: absolutePathSchema,
  launchMode: meshAgentLaunchModeSchema.optional(),
  runtimeRole: meshAgentRuntimeRoleSchema.optional(),
  providerSessionRef: z.string().min(1).optional()
});
export type StartMeshAgentRequest = z.infer<typeof startMeshAgentRequestSchema>;

export const startMeshAgentResponseSchema = z.object({ session: meshSessionViewSchema });
export type StartMeshAgentResponse = z.infer<typeof startMeshAgentResponseSchema>;

export const getMeshSessionResponseSchema = z.object({ session: meshSessionViewSchema });
export type GetMeshSessionResponse = z.infer<typeof getMeshSessionResponseSchema>;

export const listMeshSessionsResponseSchema = z.object({ sessions: z.array(meshSessionViewSchema) });
export type ListMeshSessionsResponse = z.infer<typeof listMeshSessionsResponseSchema>;

export const listMeshAgentRuntimesQuerySchema = cursorPaginationQuerySchema;
export type ListMeshAgentRuntimesQuery = z.infer<typeof listMeshAgentRuntimesQuerySchema>;

export const listMeshAgentRuntimesResponseSchema = cursorPaginationResponseSchema.extend({
  sessions: z.array(meshSessionViewSchema)
});
export type ListMeshAgentRuntimesResponse = z.infer<typeof listMeshAgentRuntimesResponseSchema>;

export const startMeshAgentAuthResponseSchema = z.object({ session: meshAgentAuthSessionViewSchema });
export type StartMeshAgentAuthResponse = z.infer<typeof startMeshAgentAuthResponseSchema>;

export const getMeshAgentAuthSessionResponseSchema = z.object({ session: meshAgentAuthSessionViewSchema });
export type GetMeshAgentAuthSessionResponse = z.infer<typeof getMeshAgentAuthSessionResponseSchema>;

export const meshAgentAuthStatusResponseSchema = z.object({
  agentName: z.string(),
  provider: meshAgentProviderSchema,
  state: meshAgentAuthStateSchema,
  output: z.string().default(''),
  checkedAt: z.string()
});
export type MeshAgentAuthStatusResponse = z.infer<typeof meshAgentAuthStatusResponseSchema>;

export const meshAgentInputRequestSchema = z.object({ input: z.string() });
export type MeshAgentInputRequest = z.infer<typeof meshAgentInputRequestSchema>;

export const meshAgentResizeRequestSchema = z.object({
  cols: z.number().int().positive(),
  rows: z.number().int().positive()
});
export type MeshAgentResizeRequest = z.infer<typeof meshAgentResizeRequestSchema>;

export const meshAgentApprovalResolutionRequestSchema = z.object({
  requestId: z.string().min(1),
  allow: z.boolean(),
  reason: z.string().optional()
});
export type MeshAgentApprovalResolutionRequest = z.infer<typeof meshAgentApprovalResolutionRequestSchema>;
