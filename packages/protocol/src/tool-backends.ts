import { z } from 'zod';

import { nativeCredentialConfiguredViewSchema, nativeCredentialUpdateSchema } from './native-credential.ts';

export const smtpSettingsSchema = z
  .object({
    host: z.string(),
    port: z.number().int().positive().optional(),
    user: z.string().optional(),
    pass: nativeCredentialConfiguredViewSchema,
    secure: z.boolean().optional(),
    clientName: z.string().optional()
  })
  .strict();
export type SmtpSettings = z.infer<typeof smtpSettingsSchema>;

const smtpSettingsWriteSchema = z
  .object({
    host: z.string(),
    port: z.number().int().positive().optional(),
    user: z.string().optional(),
    pass: nativeCredentialUpdateSchema.optional(),
    secure: z.boolean().optional(),
    clientName: z.string().optional()
  })
  .strict();

const smtpSettingsUpdateSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('replace'), value: smtpSettingsWriteSchema }).strict(),
  z.object({ action: z.literal('remove') }).strict()
]);

export const toolBackendsResponseSchema = z
  .object({
    webSearch: z
      .object({
        provider: z.enum(['auto', 'native', 'brave', 'ddgs']),
        braveApiKey: nativeCredentialConfiguredViewSchema
      })
      .strict(),
    email: z
      .object({
        backend: z.enum(['auto', 'smtp', 'resend']),
        from: z.string().optional(),
        resendApiKey: nativeCredentialConfiguredViewSchema,
        smtp: smtpSettingsSchema.optional()
      })
      .strict(),
    codeExec: z
      .object({
        backend: z.string(),
        availableBackends: z.array(z.string()),
        e2bApiKey: nativeCredentialConfiguredViewSchema,
        dockerImage: z.string().optional()
      })
      .strict()
  })
  .strict();
export type ToolBackendsResponse = z.infer<typeof toolBackendsResponseSchema>;

export const setToolBackendsRequestSchema = z
  .object({
    webSearch: z
      .object({
        provider: z.enum(['auto', 'native', 'brave', 'ddgs']).optional(),
        braveApiKey: nativeCredentialUpdateSchema.optional()
      })
      .strict()
      .optional(),
    email: z
      .object({
        backend: z.enum(['auto', 'smtp', 'resend']).optional(),
        from: z.string().optional(),
        resendApiKey: nativeCredentialUpdateSchema.optional(),
        smtp: smtpSettingsUpdateSchema.optional()
      })
      .strict()
      .optional(),
    codeExec: z
      .object({
        backend: z.enum(['follow-system', 'docker', 'e2b']).optional(),
        e2bApiKey: nativeCredentialUpdateSchema.optional(),
        dockerImage: z.string().nullable().optional()
      })
      .strict()
      .optional()
  })
  .strict();
export type SetToolBackendsRequest = z.infer<typeof setToolBackendsRequestSchema>;

export const initDockerResponseSchema = z
  .object({
    ok: z.boolean(),
    image: z.string(),
    error: z.string().optional()
  })
  .strict();
export type InitDockerResponse = z.infer<typeof initDockerResponseSchema>;
