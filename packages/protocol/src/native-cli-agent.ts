import { z } from 'zod';

import { chatMessageSchema } from './domain.ts';
import { messageIdSchema, projectIdSchema, transcriptTargetIdSchema } from './ids.ts';

export const nativeCliProviderSchema = z.enum(['codex', 'claude-code', 'gemini', 'qwen']);
export type NativeCliProvider = z.infer<typeof nativeCliProviderSchema>;

export const nativeCliProductIconSchema = z.enum(['codex', 'claude-code', 'gemini', 'qwen']);
export type NativeCliProductIcon = z.infer<typeof nativeCliProductIconSchema>;

export const nativeCliLaunchModeSchema = z.enum(['pty', 'json-stream', 'app-server', 'remote-control']);
export type NativeCliLaunchMode = z.infer<typeof nativeCliLaunchModeSchema>;

export const nativeCliAgentNameSchema = z
  .string()
  .min(1)
  .refine(
    (name) => name !== '.' && name !== '..' && !/[\\/:\0]/.test(name),
    'native CLI agent name must be a safe single path segment'
  );
export type NativeCliAgentName = z.infer<typeof nativeCliAgentNameSchema>;

export const workplaceProjectMembersExtKey = 'workplaceProjectMembers';
export const workplaceProjectMemberTypeSchema = z.enum(['monad', 'acp', 'native-cli']);
export type WorkplaceProjectMemberType = z.infer<typeof workplaceProjectMemberTypeSchema>;

export const workplaceProjectMemberSettingsSchema = z.object({
  cwd: z.string().optional(),
  osSandbox: z.boolean().optional(),
  forwardMcp: z.boolean().optional(),
  launchMode: nativeCliLaunchModeSchema.optional(),
  managedProjectAgent: z.boolean().optional(),
  modelName: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  reasoningEffort: z.string().min(1).optional(),
  speed: z.enum(['standard', 'fast']).optional(),
  customPrompt: z.string().optional()
});
export type WorkplaceProjectMemberSettings = z.infer<typeof workplaceProjectMemberSettingsSchema>;

export const workplaceProjectMemberSchema = z.object({
  type: workplaceProjectMemberTypeSchema,
  name: nativeCliAgentNameSchema,
  templateName: nativeCliAgentNameSchema.optional(),
  displayName: nativeCliAgentNameSchema.optional(),
  instanceId: nativeCliAgentNameSchema.optional(),
  settings: workplaceProjectMemberSettingsSchema.optional()
});
export type WorkplaceProjectMember = z.infer<typeof workplaceProjectMemberSchema>;

export const workplaceProjectMembersExtSchema = z.array(workplaceProjectMemberSchema);
export type WorkplaceProjectMembersExt = z.infer<typeof workplaceProjectMembersExtSchema>;

export const nativeCliApprovalOwnershipSchema = z.literal('provider-owned');
export type NativeCliApprovalOwnership = z.infer<typeof nativeCliApprovalOwnershipSchema>;

export const nativeCliRuntimeRoleSchema = z.enum(['interactive', 'managed-project-agent']);
export type NativeCliRuntimeRole = z.infer<typeof nativeCliRuntimeRoleSchema>;

export const nativeCliAgentCapabilitiesSchema = z.object({
  auth: z.enum(['pty', 'status-probe', 'none']).default('none'),
  history: z.enum(['paged', 'provider-owned', 'none']).default('none'),
  resume: z.enum(['pty', 'structured', 'none']).default('pty'),
  approval: nativeCliApprovalOwnershipSchema.default('provider-owned')
});
export type NativeCliAgentCapabilities = z.infer<typeof nativeCliAgentCapabilitiesSchema>;

// Enforced at every parse (config load + wire), not just the HTTP upsert handler, so a hand-edited
// config.json can't smuggle a malformed command/env past the spawn path. Spawn is argv-based (no
// shell) so this is defense-in-depth, but it keeps the contract in one place.
export const nativeCliAgentViewSchema = z
  .object({
    name: nativeCliAgentNameSchema,
    provider: nativeCliProviderSchema,
    productIcon: nativeCliProductIconSchema.optional(),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    modelOptions: z.array(z.string().min(1)).optional(),
    reasoningEfforts: z.array(z.string().min(1)).optional(),
    enabled: z.boolean(),
    defaultLaunchMode: nativeCliLaunchModeSchema.default('pty'),
    allowDangerousMode: z.boolean().default(false),
    approvalOwnership: nativeCliApprovalOwnershipSchema.default('provider-owned'),
    capabilities: nativeCliAgentCapabilitiesSchema.optional()
  })
  .superRefine((agent, ctx) => {
    if (/\s/.test(agent.command)) {
      ctx.addIssue({
        code: 'custom',
        path: ['command'],
        message: 'command must be a binary path or name; use args for flags'
      });
    }
    if (/[;&|`$<>(){}[\]*?]/.test(agent.command)) {
      ctx.addIssue({ code: 'custom', path: ['command'], message: 'command contains unsupported shell metacharacters' });
    }
    for (const [key, value] of Object.entries(agent.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        ctx.addIssue({ code: 'custom', path: ['env', key], message: `env key "${key}" is invalid` });
      }
      if (value.includes('\0')) {
        ctx.addIssue({ code: 'custom', path: ['env', key], message: `env value for "${key}" must not contain NUL` });
      }
    }
  });
export type NativeCliAgentView = z.infer<typeof nativeCliAgentViewSchema>;

export const nativeCliAgentPresetSchema = z.object({
  id: z.string(),
  label: z.string(),
  provider: nativeCliProviderSchema,
  productIcon: nativeCliProductIconSchema,
  command: z.string(),
  args: z.array(z.string()),
  modelOptions: z.array(z.string().min(1)).optional(),
  reasoningEfforts: z.array(z.string().min(1)).optional(),
  defaultLaunchMode: nativeCliLaunchModeSchema,
  supportedLaunchModes: z.array(nativeCliLaunchModeSchema),
  installHint: z.string(),
  installUrl: z.string().url(),
  installed: z.boolean(),
  resolvedBinPath: z.string().optional(),
  capabilities: nativeCliAgentCapabilitiesSchema.optional()
});
export type NativeCliAgentPresetView = z.infer<typeof nativeCliAgentPresetSchema>;

export const nativeCliSessionStateSchema = z.enum(['starting', 'running', 'exited', 'failed', 'stopped']);
export type NativeCliSessionState = z.infer<typeof nativeCliSessionStateSchema>;

export const nativeCliAuthStateSchema = z.enum(['authenticated', 'unauthenticated', 'unknown']);
export type NativeCliAuthState = z.infer<typeof nativeCliAuthStateSchema>;

export const nativeCliAuthSessionViewSchema = z.object({
  id: z.string().regex(/^ncliauth_/),
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

// Accept POSIX (`/abs`) and Windows (`C:\abs`, `C:/abs`, `\\server\share`) absolute paths. This is a
// wire/browser-shared schema, so it can't import node:path — the daemon re-checks with path.isAbsolute.
const ABSOLUTE_PATH_RE = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;
const absolutePathSchema = z.string().refine((value) => ABSOLUTE_PATH_RE.test(value), 'workingPath must be absolute');

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

export const nativeCliObservationRoleSchema = z.enum(['agent', 'system', 'tool']);
export type NativeCliObservationRole = z.infer<typeof nativeCliObservationRoleSchema>;

export const nativeCliObservationEventSchema = z.object({
  id: z.string().min(1),
  role: nativeCliObservationRoleSchema,
  text: z.string().min(1),
  source: z.enum(['codex-exec', 'codex-app-server', 'claude-code-sdk', 'gemini-cli', 'plain-text', 'unknown']),
  providerEventType: z.string().optional(),
  raw: z.unknown().optional()
});
export type NativeCliObservationEvent = z.infer<typeof nativeCliObservationEventSchema>;

export const managedNativeCliLifecycleLogEventSchema = z.enum([
  'project.managed_native_cli.member_start_error',
  'project.managed_native_cli.resume_failed_cold_start',
  'project.managed_native_cli.delivery_error',
  'project.managed_native_cli.direct_delivery_error'
]);
export type ManagedNativeCliLifecycleLogEvent = z.infer<typeof managedNativeCliLifecycleLogEventSchema>;

export const managedProjectRuntimePromptInputSchema = z.object({
  agentName: nativeCliAgentNameSchema,
  displayName: nativeCliAgentNameSchema.optional(),
  projectId: projectIdSchema,
  nativeCliSessionId: z.string().min(1),
  provider: nativeCliProviderSchema,
  workspace: z.string().min(1),
  modelName: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  reasoningEffort: z.string().min(1).optional(),
  speed: z.enum(['standard', 'fast']).optional(),
  customPrompt: z.string().optional()
});
export type ManagedProjectRuntimePromptInput = z.infer<typeof managedProjectRuntimePromptInputSchema>;

export const managedProjectRuntimeSpecSchema = z.object({
  workspace: z.string(),
  promptFile: z.string(),
  tokenFile: z.string(),
  tokenHash: z.string(),
  wrapperBin: z.string(),
  env: z.record(z.string(), z.string()),
  prompt: z.string()
});
export type ManagedProjectRuntimeSpec = z.infer<typeof managedProjectRuntimeSpecSchema>;

export const nativeAgentProjectPostRequestSchema = z.object({
  projectId: projectIdSchema.optional(),
  threadId: z.string().optional(),
  text: z.string().min(1)
});
export type NativeAgentProjectPostRequest = z.infer<typeof nativeAgentProjectPostRequestSchema>;

export const nativeAgentProjectMessageSchema = z.object({
  id: messageIdSchema,
  projectId: projectIdSchema,
  text: z.string(),
  createdAt: z.string()
});
export type NativeAgentProjectMessage = z.infer<typeof nativeAgentProjectMessageSchema>;

export const nativeAgentProjectPostResponseSchema = z.object({
  ok: z.literal(true),
  message: nativeAgentProjectMessageSchema
});
export type NativeAgentProjectPostResponse = z.infer<typeof nativeAgentProjectPostResponseSchema>;

export const nativeAgentProjectReadRequestSchema = z.object({
  projectId: projectIdSchema.optional(),
  threadId: z.string().optional(),
  before: z.string().optional(),
  after: z.string().optional(),
  around: z.string().optional(),
  limit: z.number().int().positive().max(200).optional()
});
export type NativeAgentProjectReadRequest = z.infer<typeof nativeAgentProjectReadRequestSchema>;

export const nativeAgentProjectReadResponseSchema = z.object({
  messages: z.array(chatMessageSchema)
});
export type NativeAgentProjectReadResponse = z.infer<typeof nativeAgentProjectReadResponseSchema>;

export const nativeCliInboxDeliveryStateSchema = z.enum(['queued', 'delivered', 'visible', 'consumed']);
export type NativeCliInboxDeliveryState = z.infer<typeof nativeCliInboxDeliveryStateSchema>;

export const nativeCliInboxItemSchema = z.object({
  seq: z.number().int().nonnegative(),
  deliveryState: nativeCliInboxDeliveryStateSchema.default('queued'),
  message: chatMessageSchema
});
export type NativeCliInboxItem = z.infer<typeof nativeCliInboxItemSchema>;

export const nativeAgentProjectInboxRequestSchema = z.object({ projectId: projectIdSchema.optional() }).optional();
export type NativeAgentProjectInboxRequest = z.infer<typeof nativeAgentProjectInboxRequestSchema>;

export const nativeAgentProjectInboxResponseSchema = z.object({
  items: z.array(nativeCliInboxItemSchema),
  projectId: projectIdSchema,
  cursor: z.number().int().nonnegative()
});
export type NativeAgentProjectInboxResponse = z.infer<typeof nativeAgentProjectInboxResponseSchema>;

export const nativeAgentProjectInboxAckRequestSchema = z
  .object({ projectId: projectIdSchema.optional(), cursor: z.number().int().nonnegative().optional() })
  .optional();
export type NativeAgentProjectInboxAckRequest = z.infer<typeof nativeAgentProjectInboxAckRequestSchema>;

export const nativeAgentProjectInboxAckResponseSchema = z.object({
  ok: z.literal(true),
  projectId: projectIdSchema,
  cursor: z.number().int().nonnegative()
});
export type NativeAgentProjectInboxAckResponse = z.infer<typeof nativeAgentProjectInboxAckResponseSchema>;

export const nativeAgentDirectMessageSchema = z.object({
  id: messageIdSchema,
  projectId: projectIdSchema,
  nativeCliSessionId: z.string().min(1),
  fromAgent: z.string().nullable(),
  peer: z.string(),
  text: z.string(),
  createdAt: z.string()
});
export type NativeAgentDirectMessage = z.infer<typeof nativeAgentDirectMessageSchema>;

export const nativeAgentSendRequestSchema = z.object({ to: z.string().min(1), text: z.string().min(1) });
export type NativeAgentSendRequest = z.infer<typeof nativeAgentSendRequestSchema>;

export const nativeAgentSendResponseSchema = z.object({
  ok: z.literal(true),
  direct: z.literal(true),
  message: nativeAgentDirectMessageSchema
});
export type NativeAgentSendResponse = z.infer<typeof nativeAgentSendResponseSchema>;

export const nativeAgentReadRequestSchema = z.object({
  with: z.string().min(1),
  before: z.string().optional(),
  after: z.string().optional(),
  limit: z.number().int().positive().max(200).optional()
});
export type NativeAgentReadRequest = z.infer<typeof nativeAgentReadRequestSchema>;

export const nativeAgentReadResponseSchema = z.object({
  with: z.string(),
  messages: z.array(nativeAgentDirectMessageSchema),
  before: z.string().optional(),
  after: z.string().optional()
});
export type NativeAgentReadResponse = z.infer<typeof nativeAgentReadResponseSchema>;

export const nativeAgentRuntimeInfoResponseSchema = z.object({
  agentId: z.string(),
  projectId: projectIdSchema,
  nativeCliSessionId: z.string(),
  serverUrl: z.string(),
  workdir: z.string(),
  providerSessionRef: z.string().nullable().optional(),
  lastDeliveredSeq: z.number().int().nonnegative(),
  lastVisibleSeq: z.number().int().nonnegative(),
  pendingInboxCount: z.number().int().nonnegative()
});
export type NativeAgentRuntimeInfoResponse = z.infer<typeof nativeAgentRuntimeInfoResponseSchema>;
