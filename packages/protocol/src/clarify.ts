import { z } from 'zod';

export const clarifyChoiceModeSchema = z.enum(['single', 'multiple']);
export type ClarifyChoiceMode = z.infer<typeof clarifyChoiceModeSchema>;

export const clarifyAskerSchema = z.object({
  id: z.string().optional(),
  name: z.string()
});
export type ClarifyAsker = z.infer<typeof clarifyAskerSchema>;

export const clarifyFormOptionSchema = z.object({
  value: z.string(),
  label: z.string().min(1)
});
export type ClarifyFormOption = z.infer<typeof clarifyFormOptionSchema>;

export const clarifyFormFieldSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  required: z.boolean(),
  type: z.enum(['string', 'number', 'integer', 'boolean', 'single-select', 'multi-select']),
  options: z.array(clarifyFormOptionSchema).optional(),
  defaultValue: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().nonnegative().optional(),
  minItems: z.number().int().nonnegative().optional(),
  maxItems: z.number().int().nonnegative().optional(),
  pattern: z.string().optional(),
  format: z.enum(['email', 'uri', 'date', 'date-time']).optional()
});
export type ClarifyFormField = z.infer<typeof clarifyFormFieldSchema>;

export const clarifyFormSchema = z.object({
  fields: z.array(clarifyFormFieldSchema).min(1)
});
export type ClarifyForm = z.infer<typeof clarifyFormSchema>;

export const urlElicitationSchema = z
  .object({
    url: z
      .string()
      .url()
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
        return !url.username && !url.password && (url.protocol === 'https:' || (url.protocol === 'http:' && loopback));
      }),
    origin: z.string().min(1).max(255),
    elicitationId: z.string().min(1).optional()
  })
  .strict();
export type UrlElicitation = z.infer<typeof urlElicitationSchema>;
