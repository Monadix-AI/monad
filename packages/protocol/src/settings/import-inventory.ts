import { z } from 'zod';

export const importInventorySourceSchema = z.enum([
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
export type ImportInventorySource = z.infer<typeof importInventorySourceSchema>;

export const importInventoryScopeSchema = z.enum(['user', 'workspace', 'system', 'unknown']);
export type ImportInventoryScope = z.infer<typeof importInventoryScopeSchema>;

const importInventoryBaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  source: importInventorySourceSchema,
  sourceLabel: z.string().min(1),
  scope: importInventoryScopeSchema,
  path: z.string().min(1),
  shared: z.boolean().default(false),
  ownerAgentDir: z.string().min(1).optional(),
  hash: z.string().optional(),
  warnings: z.array(z.string()).default([])
});

export const importInventorySkillSchema = importInventoryBaseSchema.extend({
  kind: z.literal('skill'),
  description: z.string().optional()
});
export type ImportInventorySkill = z.infer<typeof importInventorySkillSchema>;

export const importInventoryMcpServerSchema = importInventoryBaseSchema.extend({
  kind: z.literal('mcpServer'),
  transport: z.enum(['stdio', 'http', 'unknown']),
  command: z.string().optional(),
  url: z.string().optional()
});
export type ImportInventoryMcpServer = z.infer<typeof importInventoryMcpServerSchema>;

export const importInventoryAgentSchema = importInventoryBaseSchema.extend({
  kind: z.literal('agent'),
  provider: z.string().min(1)
});
export type ImportInventoryAgent = z.infer<typeof importInventoryAgentSchema>;

export const importInventoryModelProviderSchema = importInventoryBaseSchema.extend({
  kind: z.literal('modelProvider'),
  providerType: z.string().optional(),
  model: z.string().optional()
});
export type ImportInventoryModelProvider = z.infer<typeof importInventoryModelProviderSchema>;

export const importInventoryItemSchema = z.discriminatedUnion('kind', [
  importInventorySkillSchema,
  importInventoryMcpServerSchema,
  importInventoryAgentSchema,
  importInventoryModelProviderSchema
]);
export type ImportInventoryItem = z.infer<typeof importInventoryItemSchema>;

export const importInventoryRootSchema = z.object({
  source: importInventorySourceSchema,
  sourceLabel: z.string().min(1),
  scope: importInventoryScopeSchema,
  kind: z.enum(['skills', 'mcpServers', 'agents', 'modelProviders']),
  path: z.string().min(1),
  exists: z.boolean(),
  shared: z.boolean().default(false),
  ownerAgentDir: z.string().min(1).optional(),
  warning: z.string().optional()
});
export type ImportInventoryRoot = z.infer<typeof importInventoryRootSchema>;

export const importInventoryOpenLocationRequestSchema = importInventoryRootSchema.pick({
  source: true,
  sourceLabel: true,
  scope: true,
  kind: true,
  path: true
});
export type ImportInventoryOpenLocationRequest = z.infer<typeof importInventoryOpenLocationRequestSchema>;

export const importInventoryOpenLocationResponseSchema = z.object({ ok: z.literal(true) });
export type ImportInventoryOpenLocationResponse = z.infer<typeof importInventoryOpenLocationResponseSchema>;

export const importInventoryResponseSchema = z.object({
  roots: z.array(importInventoryRootSchema),
  items: z.array(importInventoryItemSchema),
  warnings: z.array(z.string()).default([])
});
export type ImportInventoryResponse = z.infer<typeof importInventoryResponseSchema>;
