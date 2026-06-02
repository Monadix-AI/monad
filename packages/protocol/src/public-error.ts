import { z } from 'zod';

import { prefixedIdSchema } from './ids.ts';

export type RequestCorrelationId = `req_${string}`;

export const publicErrorCodeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Z][A-Z0-9_]*$/);
export const publicErrorMessageSchema = z.string().min(1).max(2048);
export const publicErrorRetryableSchema = z.boolean();
export const publicErrorRequestIdSchema: z.ZodType<RequestCorrelationId> =
  prefixedIdSchema<RequestCorrelationId>('req');

const publicErrorDetailScalarSchema = z.union([z.string().max(512), z.number().finite(), z.boolean(), z.null()]);
export const publicErrorDetailValueSchema = z.union([
  publicErrorDetailScalarSchema,
  z.array(publicErrorDetailScalarSchema).max(16)
]);
export const publicErrorDetailsSchema = z
  .record(z.string().min(1).max(64), publicErrorDetailValueSchema)
  .refine((details) => Object.keys(details).length <= 16, 'details must contain at most 16 entries');

export const publicErrorDescriptorSchema = z
  .object({
    code: publicErrorCodeSchema,
    message: publicErrorMessageSchema,
    retryable: publicErrorRetryableSchema,
    requestId: publicErrorRequestIdSchema,
    details: publicErrorDetailsSchema.optional()
  })
  .strict();

export type PublicErrorCode = z.infer<typeof publicErrorCodeSchema>;
export type PublicErrorDetails = z.infer<typeof publicErrorDetailsSchema>;
export type PublicErrorDescriptor = z.infer<typeof publicErrorDescriptorSchema>;
