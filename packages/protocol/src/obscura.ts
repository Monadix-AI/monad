import { z } from 'zod';

export const obscuraStatusResponseSchema = z.object({
  enabled: z.boolean(),
  stealth: z.boolean(),
  requestTimeoutMs: z.number().optional(),
  installed: z.boolean(),
  connected: z.boolean(),
  tools: z.array(z.string())
});
export type ObscuraStatusResponse = z.infer<typeof obscuraStatusResponseSchema>;

export const setObscuraRequestSchema = z.object({
  enabled: z.boolean(),
  stealth: z.boolean().optional(),
  requestTimeoutMs: z.number().int().positive().optional()
});
export type SetObscuraRequest = z.infer<typeof setObscuraRequestSchema>;
