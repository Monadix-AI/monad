import { z } from 'zod';

import { avatarStyleCreditSchema } from './avatar.ts';

export const licenseEntrySchema = z.object({
  name: z.string(),
  version: z.string(),
  license: z.string(),
  homepage: z
    .string()
    .regex(/^https?:\/\//)
    .optional(),
  author: z.string().optional()
});
export type LicenseEntry = z.infer<typeof licenseEntrySchema>;

export const getLicensesResponseSchema = z.object({
  packages: z.array(licenseEntrySchema),
  avatarStyles: z.array(avatarStyleCreditSchema)
});
export type GetLicensesResponse = z.infer<typeof getLicensesResponseSchema>;
