import { z } from 'zod';

import { nativeCliAgentViewSchema, nativeCliProviderSchema } from './native-cli-agent-config.ts';
import {
  importSettingsActionSchema,
  importSettingsCategorySchema,
  importSettingsRiskSchema
} from './settings/settings-import.ts';

export const adapterMigrationSourceScopeSchema = z.enum(['global', 'workspace', 'profile', 'manual']);
export type AdapterMigrationSourceScope = z.infer<typeof adapterMigrationSourceScopeSchema>;

export const adapterMigrationSourceSchema = z.object({
  path: z.string().min(1),
  scope: adapterMigrationSourceScopeSchema.default('manual'),
  label: z.string().min(1).optional()
});
export type AdapterMigrationSource = z.infer<typeof adapterMigrationSourceSchema>;

export const adapterMigrationCandidateSchema = z.object({
  provider: nativeCliProviderSchema,
  label: z.string().min(1),
  path: z.string().min(1),
  source: z.enum(['default', 'manual']).default('default'),
  scope: adapterMigrationSourceScopeSchema.default('global')
});
export type AdapterMigrationCandidate = z.infer<typeof adapterMigrationCandidateSchema>;
export const nativeCliSettingsImportCandidateSchema = adapterMigrationCandidateSchema;
export type NativeCliSettingsImportCandidate = AdapterMigrationCandidate;

export const adapterMigrationItemSchema = z.object({
  id: z.string().min(1),
  hash: z.string().min(1),
  category: importSettingsCategorySchema,
  source: z.string().min(1),
  target: z.string().min(1),
  action: importSettingsActionSchema,
  reason: z.string().min(1),
  risk: importSettingsRiskSchema,
  summary: z.string().optional(),
  agent: nativeCliAgentViewSchema.optional(),
  payload: z.unknown().optional()
});
export type AdapterMigrationItem = z.infer<typeof adapterMigrationItemSchema>;
export const nativeCliSettingsImportItemSchema = adapterMigrationItemSchema;
export type NativeCliSettingsImportItem = AdapterMigrationItem;

export const adapterMigrationPreviewRequestSchema = z
  .object({
    path: z.string().min(1).optional(),
    sources: z.array(adapterMigrationSourceSchema).min(1).optional(),
    replace: z.boolean().default(false)
  })
  .refine((request) => Boolean(request.path || request.sources?.length), 'path or sources is required');
export type AdapterMigrationPreviewRequest = z.infer<typeof adapterMigrationPreviewRequestSchema>;
export const nativeCliSettingsImportPreviewRequestSchema = adapterMigrationPreviewRequestSchema;
export type NativeCliSettingsImportPreviewRequest = AdapterMigrationPreviewRequest;

export const adapterMigrationPreviewSchema = z.object({
  provider: nativeCliProviderSchema,
  path: z.string().min(1),
  sources: z.array(adapterMigrationSourceSchema).default([]),
  items: z.array(adapterMigrationItemSchema),
  warnings: z.array(z.string()).default([])
});
export type AdapterMigrationPreview = z.infer<typeof adapterMigrationPreviewSchema>;
export const nativeCliSettingsImportPreviewSchema = adapterMigrationPreviewSchema;
export type NativeCliSettingsImportPreview = AdapterMigrationPreview;

export const listNativeCliSettingsImportCandidatesResponseSchema = z.object({
  candidates: z.array(adapterMigrationCandidateSchema)
});
export type ListNativeCliSettingsImportCandidatesResponse = z.infer<
  typeof listNativeCliSettingsImportCandidatesResponseSchema
>;

export const adapterMigrationApplyRequestSchema = adapterMigrationPreviewRequestSchema.extend({
  select: z.array(z.string()).default([]),
  hashes: z.record(z.string(), z.string()).default({})
});
export type AdapterMigrationApplyRequest = z.infer<typeof adapterMigrationApplyRequestSchema>;
export const nativeCliSettingsImportApplyRequestSchema = adapterMigrationApplyRequestSchema;
export type NativeCliSettingsImportApplyRequest = AdapterMigrationApplyRequest;

export const adapterMigrationApplyResultSchema = z.object({
  preview: adapterMigrationPreviewSchema,
  applied: z.array(z.string()),
  skipped: z.array(z.object({ id: z.string(), reason: z.string() }))
});
export type AdapterMigrationApplyResult = z.infer<typeof adapterMigrationApplyResultSchema>;
export const nativeCliSettingsImportApplyResultSchema = adapterMigrationApplyResultSchema;
export type NativeCliSettingsImportApplyResult = AdapterMigrationApplyResult;
