import { z } from 'zod';

export const networkSettingsSchema = z.object({
  port: z.number().int().min(1).max(65535),
  transport: z.enum(['tcp', 'uds']),
  remoteAccess: z.object({
    enabled: z.boolean(),
    token: z.string().nullable(),
    allowInsecureHttp: z.boolean()
  }),
  restartRequired: z.boolean()
});

export type NetworkSettings = z.infer<typeof networkSettingsSchema>;

export const setNetworkSettingsRequestSchema = z.object({
  remoteAccess: z
    .object({
      enabled: z.boolean().optional(),
      rotateToken: z.boolean().optional(),
      allowInsecureHttp: z.boolean().optional()
    })
    .optional()
});

export type SetNetworkSettingsRequest = z.infer<typeof setNetworkSettingsRequestSchema>;
