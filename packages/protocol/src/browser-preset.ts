import { z } from 'zod';

export const browserPresetResponseSchema = z.object({
  enabled: z.boolean(),
  headless: z.boolean(),
  vision: z.boolean(),
  engine: z.enum(['chrome', 'firefox', 'webkit', 'msedge']).optional(),
  device: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  autoApproveReadOnly: z.boolean().optional()
});
export type BrowserPresetResponse = z.infer<typeof browserPresetResponseSchema>;

export const setBrowserPresetRequestSchema = z.object({
  enabled: z.boolean().optional(),
  headless: z.boolean().optional(),
  vision: z.boolean().optional(),
  engine: z.enum(['chrome', 'firefox', 'webkit', 'msedge']).nullable().optional(),
  device: z.string().nullable().optional(),
  command: z.string().nullable().optional(),
  args: z.array(z.string()).nullable().optional(),
  autoApproveReadOnly: z.boolean().optional()
});
export type SetBrowserPresetRequest = z.infer<typeof setBrowserPresetRequestSchema>;
