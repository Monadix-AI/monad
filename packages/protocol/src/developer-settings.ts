import { z } from 'zod';

export const developerSettingsSchema = z.object({
  developerMode: z.boolean(),
  logsDir: z.string()
});
export type DeveloperSettings = z.infer<typeof developerSettingsSchema>;

export const setDeveloperSettingsRequestSchema = z.object({
  developerMode: z.boolean()
});
export type SetDeveloperSettingsRequest = z.infer<typeof setDeveloperSettingsRequestSchema>;
