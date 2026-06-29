import { z } from 'zod';

export const computerPresetResponseSchema = z.object({
  enabled: z.boolean(),
  command: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()).optional(),
  autoApproveReadOnly: z.boolean().optional()
});
export type ComputerPresetResponse = z.infer<typeof computerPresetResponseSchema>;

export const setComputerPresetRequestSchema = z.object({
  enabled: z.boolean().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).nullable().optional(),
  autoApproveReadOnly: z.boolean().optional()
});
export type SetComputerPresetRequest = z.infer<typeof setComputerPresetRequestSchema>;
