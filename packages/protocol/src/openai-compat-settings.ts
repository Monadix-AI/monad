import { z } from 'zod';

export const openaiCompatSettingsSchema = z.object({
  enabled: z.boolean(),
  token: z.string().optional()
});

export type OpenaiCompatSettings = z.infer<typeof openaiCompatSettingsSchema>;

export const setOpenaiCompatRequestSchema = openaiCompatSettingsSchema;
export type SetOpenaiCompatRequest = z.infer<typeof setOpenaiCompatRequestSchema>;
