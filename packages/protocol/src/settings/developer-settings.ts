import { z } from 'zod';

export const developerLogAutoCleanupSchema = z
  .object({
    enabled: z.boolean(),
    retentionDays: z.number().int().min(1).max(30)
  })
  .strict();

export const developerSettingsSchema = z
  .object({
    developerMode: z.boolean(),
    logsDir: z.string(),
    logs: z
      .object({
        autoCleanup: developerLogAutoCleanupSchema
      })
      .strict()
  })
  .strict();
export type DeveloperSettings = z.infer<typeof developerSettingsSchema>;

export const setDeveloperSettingsRequestSchema = z
  .object({
    developerMode: z.boolean().optional(),
    logs: z
      .object({
        autoCleanup: developerLogAutoCleanupSchema.optional()
      })
      .strict()
      .optional()
  })
  .strict();
export type SetDeveloperSettingsRequest = z.infer<typeof setDeveloperSettingsRequestSchema>;

export const previewLogCleanupRequestSchema = developerLogAutoCleanupSchema;
export type PreviewLogCleanupRequest = z.infer<typeof previewLogCleanupRequestSchema>;

export const logCleanupPreviewSchema = z
  .object({
    files: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative()
  })
  .strict();
export type LogCleanupPreview = z.infer<typeof logCleanupPreviewSchema>;

export const logCleanupResultSchema = z
  .object({
    filesCleared: z.number().int().nonnegative(),
    filesFailed: z.number().int().nonnegative(),
    bytesFreed: z.number().int().nonnegative()
  })
  .strict();
export type LogCleanupResult = z.infer<typeof logCleanupResultSchema>;
