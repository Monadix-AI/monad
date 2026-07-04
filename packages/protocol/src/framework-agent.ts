import { z } from 'zod';

export const frameworkProviderSchema = z.enum(['openclaw', 'hermes']);
export type FrameworkProvider = z.infer<typeof frameworkProviderSchema>;

export const frameworkTransportKindSchema = z.enum(['cli-oneshot', 'cli-stdio', 'http-openai-compat', 'custom']);
export type FrameworkTransportKind = z.infer<typeof frameworkTransportKindSchema>;

export const frameworkAgentViewSchema = z.object({
  name: z.string().min(1),
  provider: frameworkProviderSchema,
  transport: frameworkTransportKindSchema,
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  baseUrl: z.string().url().optional(),
  tokenRef: z.string().optional(),
  defaultModel: z.string().optional(),
  enabled: z.boolean(),
  osSandbox: z.boolean().optional(),
  forwardMcp: z.boolean().optional()
});
export type FrameworkAgentView = z.infer<typeof frameworkAgentViewSchema>;

export const listFrameworkAgentsResponseSchema = z.object({ agents: z.array(frameworkAgentViewSchema) });
export type ListFrameworkAgentsResponse = z.infer<typeof listFrameworkAgentsResponseSchema>;

export const upsertFrameworkAgentRequestSchema = z.object({ agent: frameworkAgentViewSchema });
export type UpsertFrameworkAgentRequest = z.infer<typeof upsertFrameworkAgentRequestSchema>;

export const setFrameworkAgentEnabledRequestSchema = z.object({ enabled: z.boolean() });
export type SetFrameworkAgentEnabledRequest = z.infer<typeof setFrameworkAgentEnabledRequestSchema>;
