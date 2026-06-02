import { z } from 'zod';

export const networkRemoteUrlSchema = z.object({
  kind: z.enum(['lan', 'overlay']),
  label: z.string(),
  url: z.url()
});
export type NetworkRemoteUrl = z.infer<typeof networkRemoteUrlSchema>;

export const networkRuntimeListenerSchema = z.object({
  scheme: z.enum(['https', 'http']),
  host: z.string(),
  port: z.number().int().min(1).max(65535)
});
export type NetworkRuntimeListener = z.infer<typeof networkRuntimeListenerSchema>;

export const networkRuntimeStatusSchema = z.object({
  listeners: z.array(networkRuntimeListenerSchema),
  remoteAccess: z.object({
    enabled: z.boolean(),
    tokenRevision: z.number().int().nonnegative()
  }),
  lastAppliedAt: z.string().optional(),
  lastError: z
    .object({
      at: z.string(),
      message: z.string()
    })
    .optional()
});
export type NetworkRuntimeStatus = z.infer<typeof networkRuntimeStatusSchema>;

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
  remoteUrls: z.array(networkRemoteUrlSchema).default([]),
  runtime: networkRuntimeStatusSchema.optional(),
  restartRequired: z.boolean()
});

export type NetworkSettings = z.infer<typeof networkSettingsSchema>;

export const setNetworkSettingsRequestSchema = z.object({
  confirmInsecureRemoteAccess: z.boolean().optional(),
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

export const probeNetworkRequestSchema = z.object({
  url: z.url(),
  token: z.string().optional()
});
export type ProbeNetworkRequest = z.infer<typeof probeNetworkRequestSchema>;

export const probeNetworkResponseSchema = z.object({
  ok: z.boolean(),
  status: z.number().int().optional(),
  latencyMs: z.number().nonnegative(),
  error: z.string().optional()
});
export type ProbeNetworkResponse = z.infer<typeof probeNetworkResponseSchema>;
