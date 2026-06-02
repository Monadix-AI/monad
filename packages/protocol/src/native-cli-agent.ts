import { z } from 'zod';

import { sessionIdSchema } from './ids.ts';

export const nativeCliProviderSchema = z.enum(['codex', 'claude-code']);
export type NativeCliProvider = z.infer<typeof nativeCliProviderSchema>;

export const nativeCliLaunchModeSchema = z.enum(['pty', 'json-stream', 'app-server', 'remote-control']);
export type NativeCliLaunchMode = z.infer<typeof nativeCliLaunchModeSchema>;

export const nativeCliApprovalOwnershipSchema = z.literal('provider-owned');
export type NativeCliApprovalOwnership = z.infer<typeof nativeCliApprovalOwnershipSchema>;

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
    name: z.string().min(1),
    provider: nativeCliProviderSchema,
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
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
  command: z.string(),
  args: z.array(z.string()),
  defaultLaunchMode: nativeCliLaunchModeSchema,
  supportedLaunchModes: z.array(nativeCliLaunchModeSchema),
  installHint: z.string(),
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
  projectSessionId: sessionIdSchema,
  agentName: z.string(),
  provider: nativeCliProviderSchema,
  workingPath: z.string(),
  launchMode: nativeCliLaunchModeSchema,
  approvalOwnership: nativeCliApprovalOwnershipSchema.default('provider-owned'),
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
  agentName: z.string().min(1),
  workingPath: absolutePathSchema,
  launchMode: nativeCliLaunchModeSchema.optional(),
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
