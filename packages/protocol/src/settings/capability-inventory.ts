import { z } from 'zod';

export const capabilityInventorySourceSchema = z.enum([
  'shared',
  'monad',
  'codex',
  'claude-code',
  'gemini',
  'qwen',
  'openclaw',
  'hermes',
  'copilot',
  'cursor',
  'vscode',
  'custom'
]);
export type CapabilityInventorySource = z.infer<typeof capabilityInventorySourceSchema>;

export const capabilityInventoryScopeSchema = z.enum(['user', 'workspace', 'system', 'unknown']);
export type CapabilityInventoryScope = z.infer<typeof capabilityInventoryScopeSchema>;

const capabilityInventoryBaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  source: capabilityInventorySourceSchema,
  sourceLabel: z.string().min(1),
  scope: capabilityInventoryScopeSchema,
  path: z.string().min(1),
  shared: z.boolean().default(false),
  hash: z.string().optional(),
  warnings: z.array(z.string()).default([])
});

export const capabilityInventorySkillSchema = capabilityInventoryBaseSchema.extend({
  kind: z.literal('skill'),
  description: z.string().optional()
});
export type CapabilityInventorySkill = z.infer<typeof capabilityInventorySkillSchema>;

export const capabilityInventoryMcpServerSchema = capabilityInventoryBaseSchema.extend({
  kind: z.literal('mcpServer'),
  transport: z.enum(['stdio', 'http', 'unknown']),
  command: z.string().optional(),
  url: z.string().optional()
});
export type CapabilityInventoryMcpServer = z.infer<typeof capabilityInventoryMcpServerSchema>;

export const capabilityInventoryAgentSchema = capabilityInventoryBaseSchema.extend({
  kind: z.literal('agent'),
  provider: z.string().min(1)
});
export type CapabilityInventoryAgent = z.infer<typeof capabilityInventoryAgentSchema>;

export const capabilityInventoryModelProviderSchema = capabilityInventoryBaseSchema.extend({
  kind: z.literal('modelProvider'),
  providerType: z.string().optional(),
  model: z.string().optional()
});
export type CapabilityInventoryModelProvider = z.infer<typeof capabilityInventoryModelProviderSchema>;

export const capabilityInventoryItemSchema = z.discriminatedUnion('kind', [
  capabilityInventorySkillSchema,
  capabilityInventoryMcpServerSchema,
  capabilityInventoryAgentSchema,
  capabilityInventoryModelProviderSchema
]);
export type CapabilityInventoryItem = z.infer<typeof capabilityInventoryItemSchema>;

export const capabilityInventoryRootSchema = z.object({
  source: capabilityInventorySourceSchema,
  sourceLabel: z.string().min(1),
  scope: capabilityInventoryScopeSchema,
  kind: z.enum(['skills', 'mcpServers', 'agents', 'modelProviders']),
  path: z.string().min(1),
  exists: z.boolean(),
  shared: z.boolean().default(false),
  warning: z.string().optional()
});
export type CapabilityInventoryRoot = z.infer<typeof capabilityInventoryRootSchema>;

export const capabilityInventoryOpenLocationRequestSchema = capabilityInventoryRootSchema.pick({
  source: true,
  sourceLabel: true,
  scope: true,
  kind: true,
  path: true
});
export type CapabilityInventoryOpenLocationRequest = z.infer<typeof capabilityInventoryOpenLocationRequestSchema>;

export const capabilityInventoryOpenLocationResponseSchema = z.object({ ok: z.literal(true) });
export type CapabilityInventoryOpenLocationResponse = z.infer<typeof capabilityInventoryOpenLocationResponseSchema>;

export const capabilityInventoryResponseSchema = z.object({
  roots: z.array(capabilityInventoryRootSchema),
  items: z.array(capabilityInventoryItemSchema),
  warnings: z.array(z.string()).default([])
});
export type CapabilityInventoryResponse = z.infer<typeof capabilityInventoryResponseSchema>;
