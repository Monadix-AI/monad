import { z } from 'zod';

export const importSettingsSourceSchema = z.enum([
  'auto',
  'codex',
  'claude-code',
  'hermes',
  'openclaw',
  'cursor',
  'claude-desktop',
  'vscode',
  'aider',
  'continue',
  'roo-code'
]);
export type ImportSettingsSource = z.infer<typeof importSettingsSourceSchema>;

export const importSettingsCategorySchema = z.enum([
  'meshAgents',
  'skills',
  'mcpServers',
  'modelProviders',
  'modelProfiles',
  'modelRoles',
  'credentials',
  'hooks',
  'sandbox',
  'approvals',
  'tools',
  'channels',
  'agents',
  'plugins'
]);
export type ImportSettingsCategory = z.infer<typeof importSettingsCategorySchema>;

export const importSettingsActionSchema = z.enum(['add', 'update', 'skip', 'conflict', 'manual']);
export type ImportSettingsAction = z.infer<typeof importSettingsActionSchema>;

export const importSettingsRiskSchema = z.enum(['low', 'medium', 'high']);
export type ImportSettingsRisk = z.infer<typeof importSettingsRiskSchema>;

export const importSettingsRequestSchema = z.object({
  from: importSettingsSourceSchema.default('auto'),
  path: z.string().min(1),
  replace: z.boolean().default(false)
});
export type ImportSettingsRequest = z.infer<typeof importSettingsRequestSchema>;

export const importSettingsItemSchema = z.object({
  id: z.string().min(1),
  hash: z.string().min(1),
  category: importSettingsCategorySchema,
  source: z.string().min(1),
  target: z.string().min(1),
  action: importSettingsActionSchema,
  reason: z.string().min(1),
  risk: importSettingsRiskSchema,
  summary: z.string().optional()
});
export type ImportSettingsItem = z.infer<typeof importSettingsItemSchema>;

export const importSettingsPreviewSchema = z.object({
  from: importSettingsSourceSchema.exclude(['auto']),
  path: z.string(),
  items: z.array(importSettingsItemSchema),
  warnings: z.array(z.string()).default([])
});
export type ImportSettingsPreview = z.infer<typeof importSettingsPreviewSchema>;

export const importSettingsApplyRequestSchema = importSettingsRequestSchema.extend({
  select: z.array(z.string()).default([]),
  allSafe: z.boolean().default(false),
  hashes: z.record(z.string(), z.string()).default({})
});
export type ImportSettingsApplyRequest = z.infer<typeof importSettingsApplyRequestSchema>;

export const importSettingsApplyResultSchema = z.object({
  preview: importSettingsPreviewSchema,
  applied: z.array(z.string()),
  skipped: z.array(z.object({ id: z.string(), reason: z.string() }))
});
export type ImportSettingsApplyResult = z.infer<typeof importSettingsApplyResultSchema>;
