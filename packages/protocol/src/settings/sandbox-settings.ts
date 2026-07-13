import { z } from 'zod';

import { sandboxModeSchema } from '../domain.ts';
import { interactionFieldSchema } from '../interaction.ts';

const sandboxNetSchema = z.enum(['none', 'unrestricted', 'filtered']);
const hostExecSchema = z.enum(['deny', 'ask', 'allow']);

export const sandboxBackendRefSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('builtin'), kind: z.string().min(1).max(80) }).strict(),
  z
    .object({ source: z.literal('atom-pack'), packId: z.string().min(1).max(200), kind: z.string().min(1).max(80) })
    .strict()
]);
export type SandboxBackendRef = z.infer<typeof sandboxBackendRefSchema>;

export const sandboxSettingsSchema = z.object({ fields: z.array(interactionFieldSchema).max(32) }).strict();
export type SandboxSettingsSchema = z.infer<typeof sandboxSettingsSchema>;

export const sandboxLauncherDescriptorSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(2_000).optional(),
    settings: sandboxSettingsSchema.optional()
  })
  .strict();
export type SandboxLauncherDescriptor = z.infer<typeof sandboxLauncherDescriptorSchema>;

export const sandboxBackendViewSchema = z
  .object({
    ref: sandboxBackendRefSchema,
    descriptor: sandboxLauncherDescriptorSchema,
    sourceLabel: z.string(),
    platforms: z.array(z.string()).optional(),
    enforces: z
      .object({
        writeConfine: z.boolean().optional(),
        readDeny: z.boolean().optional(),
        net: z.array(z.enum(['none', 'filtered', 'unrestricted'])).optional()
      })
      .optional(),
    status: z.enum(['active', 'available', 'unavailable', 'preparing', 'error']),
    statusDetail: z.string().optional(),
    settings: z.record(z.string(), z.unknown())
  })
  .strict();
export type SandboxBackendView = z.infer<typeof sandboxBackendViewSchema>;

const backendSettingsViewSchema = z.record(z.string(), z.record(z.string(), z.unknown()));
const backendSecretUpdateSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('replace'), value: z.string().min(1) }).strict(),
  z.object({ action: z.literal('remove') }).strict()
]);

/** The system-level sandbox defaults (cfg.agent.sandbox) plus the global ceiling (cfg.agent.globalSandbox).
 *  The renderable subset — advanced knobs (env, seedTemplate, initScript, launcherPath) stay config-only. */
export const sandboxSettingsResponseSchema = z.object({
  sandbox: z.object({
    mode: sandboxModeSchema,
    confine: z.boolean(),
    net: sandboxNetSchema,
    allowedDomains: z.array(z.string()),
    hostExec: hostExecSchema
  }),
  /** When enabled, EVERY agent is forced to `mode` and per-agent sandbox overrides are ignored. */
  globalSandbox: z.object({ enabled: z.boolean(), mode: sandboxModeSchema }),
  activeBackend: sandboxBackendRefSchema,
  /** Opaque backend-scoped settings. Secret values are always represented as `{ configured }`. */
  backendSettings: backendSettingsViewSchema,
  backends: z.array(sandboxBackendViewSchema)
});
export type SandboxSettingsResponse = z.infer<typeof sandboxSettingsResponseSchema>;

export const setSandboxSettingsRequestSchema = z.object({
  sandbox: z
    .object({
      mode: sandboxModeSchema.optional(),
      confine: z.boolean().optional(),
      net: sandboxNetSchema.optional(),
      allowedDomains: z.array(z.string()).optional(),
      hostExec: hostExecSchema.optional()
    })
    .optional(),
  globalSandbox: z.object({ enabled: z.boolean().optional(), mode: sandboxModeSchema.optional() }).optional(),
  backendSettings: z
    .object({
      ref: sandboxBackendRefSchema,
      values: z.record(z.string(), z.unknown()).optional(),
      secrets: z.record(z.string(), backendSecretUpdateSchema).optional()
    })
    .strict()
    .optional()
});
export type SetSandboxSettingsRequest = z.infer<typeof setSandboxSettingsRequestSchema>;

export const activateSandboxBackendRequestSchema = z
  .object({
    ref: sandboxBackendRefSchema,
    settings: z
      .object({
        values: z.record(z.string(), z.unknown()).optional(),
        secrets: z.record(z.string(), backendSecretUpdateSchema).optional()
      })
      .strict()
      .optional()
  })
  .strict();
export type ActivateSandboxBackendRequest = z.infer<typeof activateSandboxBackendRequestSchema>;

export const sandboxActivationResultSchema = z
  .object({
    requested: sandboxBackendRefSchema,
    effective: sandboxBackendRefSchema,
    status: z.enum(['active', 'error']),
    error: z.string().optional(),
    cleanupWarning: z.string().optional()
  })
  .strict();
export type SandboxActivationResult = z.infer<typeof sandboxActivationResultSchema>;
