import { z } from 'zod';

import { clarifyChoiceModeSchema } from './clarify.ts';
import { chatMessageSchema } from './domain.ts';
import { attachmentIdSchema, messageIdSchema, projectIdSchema, transcriptTargetIdSchema } from './ids.ts';

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
const absolutePath = (message: string) =>
  z
    .string()
    .min(1)
    .refine((value) => ABSOLUTE_PATH_RE.test(value), message);
const absolutePathSchema = absolutePath('workingPath must be absolute');

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

// Inline request-body cap (DoS guard). Longer content is spilled to a file and referenced as an
// attachment: the message/notice/inbox copies carry only a bounded preview + the file reference.
export const NATIVE_AGENT_INLINE_TEXT_MAX = 100_000;
// Preview snippet length embedded in wall messages and stdin fan-out notices.
export const NATIVE_AGENT_ATTACHMENT_PREVIEW_MAX = 2_000;

/** Bounded preview snippet for spilled content — what wall messages and fan-out notices embed.
 *  The cut point backs off one unit rather than splitting a surrogate pair (a split pair would
 *  render as � and re-encode as ill-formed UTF-8). */
export function attachmentPreviewText(text: string): string {
  if (text.length <= NATIVE_AGENT_ATTACHMENT_PREVIEW_MAX) return text;
  let end = NATIVE_AGENT_ATTACHMENT_PREVIEW_MAX;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** Mime families whose content is rendered as an inline text preview (daemon read + web button).
 *  Shared so the server's preview behavior and the client's Preview affordance never drift. */
const PREVIEWABLE_ATTACHMENT_MIME_RE = /^(text\/|application\/(json|x?ya?ml|xml|toml|javascript|typescript))/;
export function isPreviewableAttachmentMime(mime: string): boolean {
  return PREVIEWABLE_ATTACHMENT_MIME_RE.test(mime);
}

/** A message attachment is a STRUCTURED REFERENCE to a file on the daemon host — for humans to
 *  read (wall preview/download), never an execution input. The daemon registers the reference and
 *  snapshots metadata at post time; content stays in the file and is read on demand, so a later
 *  edit/delete of the file changes/breaks the preview (reference semantics, by design). */
export const messageAttachmentRefSchema = z.object({
  id: attachmentIdSchema,
  /** Absolute path on the daemon host (typically inside the posting agent's workspace). */
  path: z.string().min(1),
  name: z.string().min(1).max(200),
  mime: z.string().min(1).max(100),
  /** File size snapshot taken when the reference was registered. */
  bytes: z.number().int().nonnegative(),
  createdAt: z.string()
});
export type MessageAttachmentRef = z.infer<typeof messageAttachmentRefSchema>;

/** Caller-side attachment input: the local file to reference from the message. */
export const nativeAgentAttachmentInputSchema = z.object({
  path: absolutePath('attachment path must be absolute'),
  name: z.string().min(1).max(200).optional(),
  mime: z.string().min(1).max(100).optional()
});
export type NativeAgentAttachmentInput = z.infer<typeof nativeAgentAttachmentInputSchema>;

/** Client-facing read of a registered attachment (web wall preview). `text` is a bounded inline
 *  read of the referenced file; `truncated` marks a partial read of a larger file. */
export const attachmentReadResponseSchema = z.object({
  attachment: messageAttachmentRefSchema,
  text: z.string(),
  truncated: z.boolean().optional()
});
export type AttachmentReadResponse = z.infer<typeof attachmentReadResponseSchema>;

// Per-message attachment count cap.
export const NATIVE_AGENT_ATTACHMENTS_MAX = 10;

const attachmentInputsSchema = z.array(nativeAgentAttachmentInputSchema).min(1).max(NATIVE_AGENT_ATTACHMENTS_MAX);

// `text` is the inline body; `attachments` reference local files whose content is the
// human-readable payload (the stored message text is then a preview + reference markers). At least
// one must be present; the inline cap stays as the fallback DoS guard.
export const nativeAgentProjectPostRequestSchema = z
  .object({
    projectId: projectIdSchema.optional(),
    threadId: z.string().optional(),
    text: z.string().min(1).max(NATIVE_AGENT_INLINE_TEXT_MAX).optional(),
    attachments: attachmentInputsSchema.optional()
  })
  .refine((v) => v.text !== undefined || v.attachments !== undefined, 'text or attachments is required');
export type NativeAgentProjectPostRequest = z.infer<typeof nativeAgentProjectPostRequestSchema>;

export const nativeAgentProjectMessageSchema = z.object({
  id: messageIdSchema,
  projectId: projectIdSchema,
  text: z.string(),
  attachments: z.array(messageAttachmentRefSchema).optional(),
  createdAt: z.string()
});
export type NativeAgentProjectMessage = z.infer<typeof nativeAgentProjectMessageSchema>;

export const nativeAgentProjectPostResponseSchema = z.object({
  ok: z.literal(true),
  message: nativeAgentProjectMessageSchema
});
export type NativeAgentProjectPostResponse = z.infer<typeof nativeAgentProjectPostResponseSchema>;

export const nativeAgentProjectAskRequestSchema = z.object({
  projectId: projectIdSchema.optional(),
  question: z.string().min(1).max(10_000),
  options: z.array(z.string().min(1).max(1_000)).max(10).default([]),
  mode: clarifyChoiceModeSchema.default('single'),
  allowOther: z.boolean().default(true)
});
export type NativeAgentProjectAskRequest = z.infer<typeof nativeAgentProjectAskRequestSchema>;

export const nativeAgentProjectAskResponseSchema = z.object({
  ok: z.literal(true),
  requestId: z.string(),
  answer: z.string()
});
export type NativeAgentProjectAskResponse = z.infer<typeof nativeAgentProjectAskResponseSchema>;

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
  attachments: z.array(messageAttachmentRefSchema).optional(),
  createdAt: z.string()
});
export type NativeAgentDirectMessage = z.infer<typeof nativeAgentDirectMessageSchema>;

// Same inline/attachments split as project post — see nativeAgentProjectPostRequestSchema.
export const nativeAgentSendRequestSchema = z
  .object({
    to: z.string().min(1).max(200),
    text: z.string().min(1).max(NATIVE_AGENT_INLINE_TEXT_MAX).optional(),
    attachments: attachmentInputsSchema.optional()
  })
  .refine((v) => v.text !== undefined || v.attachments !== undefined, 'text or attachments is required');
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
