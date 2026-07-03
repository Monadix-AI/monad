import { z } from 'zod';

export const startupSettingsSchema = z.object({
  enabled: z.boolean(),
  supported: z.boolean(),
  platform: z.string(),
  command: z.array(z.string()).optional(),
  reason: z.string().optional()
});
export type StartupSettings = z.infer<typeof startupSettingsSchema>;

export const setStartupSettingsRequestSchema = z.object({
  enabled: z.boolean()
});
export type SetStartupSettingsRequest = z.infer<typeof setStartupSettingsRequestSchema>;
