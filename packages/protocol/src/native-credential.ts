import { z } from 'zod';

import { httpUrlSchema } from './url.ts';

export const nativeCredentialConfiguredViewSchema = z.object({ configured: z.boolean() }).strict();

export const nativeCredentialUpdateSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('replace'),
      value: z
        .string()
        .min(1)
        .refine((value) => !value.startsWith('${secret:'), {
          message: 'native credentials must be stored directly'
        })
    })
    .strict(),
  z.object({ action: z.literal('remove') }).strict()
]);

export const atomRegistriesViewSchema = z
  .object({
    github: z.object({ token: nativeCredentialConfiguredViewSchema }).strict().optional(),
    npm: z
      .object({
        token: nativeCredentialConfiguredViewSchema,
        registry: httpUrlSchema.optional()
      })
      .strict()
      .optional()
  })
  .strict();
export type AtomRegistriesView = z.infer<typeof atomRegistriesViewSchema>;

export const atomRegistriesUpdateSchema = z
  .object({
    github: z.object({ token: nativeCredentialUpdateSchema }).strict().optional(),
    npm: z
      .object({
        token: nativeCredentialUpdateSchema.optional(),
        registry: httpUrlSchema.optional()
      })
      .strict()
      .optional()
  })
  .strict();
export type AtomRegistriesUpdate = z.infer<typeof atomRegistriesUpdateSchema>;
