import { z } from 'zod';

export const networkSettingsSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  transport: z.enum(['tcp', 'uds']),
  https: z.object({
    enabled: z.boolean()
  }),
  remoteAccess: z.object({
    enabled: z.boolean(),
    token: z.string().nullable()
  }),
  localHttpFallback: z.object({
    enabled: z.boolean(),
    port: z.number().int().min(1).max(65535)
  }),
  restartRequired: z.boolean()
});

export type NetworkSettings = z.infer<typeof networkSettingsSchema>;

export const setNetworkSettingsRequestSchema = z.object({
  host: z.string().min(1).optional(),
  https: z
    .object({
      enabled: z.boolean().optional()
    })
    .optional(),
  remoteAccess: z
    .object({
      enabled: z.boolean().optional(),
      rotateToken: z.boolean().optional()
    })
    .optional(),
  localHttpFallback: z
    .object({
      enabled: z.boolean().optional(),
      port: z.number().int().min(1).max(65535).optional()
    })
    .optional()
});

export type SetNetworkSettingsRequest = z.infer<typeof setNetworkSettingsRequestSchema>;
