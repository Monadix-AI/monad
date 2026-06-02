import { z } from 'zod';

import { sandboxModeSchema } from './domain.ts';

const sandboxNetSchema = z.enum(['none', 'unrestricted', 'filtered']);
const hostExecSchema = z.enum(['deny', 'ask', 'allow']);

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
  globalSandbox: z.object({ enabled: z.boolean(), mode: sandboxModeSchema })
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
  globalSandbox: z.object({ enabled: z.boolean().optional(), mode: sandboxModeSchema.optional() }).optional()
});
export type SetSandboxSettingsRequest = z.infer<typeof setSandboxSettingsRequestSchema>;
