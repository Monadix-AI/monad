import { z } from 'zod';

export const startupSettingsSchema = z.object({
  enabled: z.boolean(),
  supported: z.boolean(),
  platform: z.string(),
  command: z.array(z.string()).optional(),
  reason: z.string().optional()
});
export type StartupSettings = z.infer<typeof startupSettingsSchema>;

export const openStartupSettingsResponseSchema = z.object({
  ok: z.literal(true),
  target: z.string()
});
export type OpenStartupSettingsResponse = z.infer<typeof openStartupSettingsResponseSchema>;

export const setStartupSettingsRequestSchema = z.object({
  enabled: z.boolean()
});
export type SetStartupSettingsRequest = z.infer<typeof setStartupSettingsRequestSchema>;
