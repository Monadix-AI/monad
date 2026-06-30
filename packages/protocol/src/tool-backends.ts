import { z } from 'zod';

export const smtpSettingsSchema = z.object({
  host: z.string(),
  port: z.number().int().positive().optional(),
  user: z.string().optional(),
  pass: z.string().optional(),
  secure: z.boolean().optional(),
  clientName: z.string().optional()
});
export type SmtpSettings = z.infer<typeof smtpSettingsSchema>;

export const toolBackendsResponseSchema = z.object({
  webSearch: z.object({
    provider: z.enum(['auto', 'native', 'brave', 'ddgs']),
    braveApiKey: z.string().optional()
  }),
  email: z.object({
    backend: z.enum(['auto', 'smtp', 'resend']),
    from: z.string().optional(),
    resendApiKey: z.string().optional(),
    smtp: smtpSettingsSchema.optional()
  }),
  codeExec: z.object({
    backend: z.string(),
    availableBackends: z.array(z.string()),
    e2bApiKey: z.string().optional(),
    dockerImage: z.string().optional()
  })
});
export type ToolBackendsResponse = z.infer<typeof toolBackendsResponseSchema>;

export const setToolBackendsRequestSchema = z.object({
  webSearch: z
    .object({
      provider: z.enum(['auto', 'native', 'brave', 'ddgs']).optional(),
      braveApiKey: z.string().optional()
    })
    .optional(),
  email: z
    .object({
      backend: z.enum(['auto', 'smtp', 'resend']).optional(),
      from: z.string().optional(),
      resendApiKey: z.string().optional(),
      smtp: smtpSettingsSchema.nullable().optional()
    })
    .optional(),
  codeExec: z
    .object({
      backend: z.enum(['follow-system', 'docker', 'e2b']).optional(),
      e2bApiKey: z.string().nullable().optional(),
      dockerImage: z.string().nullable().optional()
    })
    .optional()
});
export type SetToolBackendsRequest = z.infer<typeof setToolBackendsRequestSchema>;

export const initDockerResponseSchema = z.object({
  ok: z.boolean(),
  image: z.string(),
  error: z.string().optional()
});
export type InitDockerResponse = z.infer<typeof initDockerResponseSchema>;
