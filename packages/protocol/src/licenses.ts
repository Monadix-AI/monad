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

export const licensePackageGroupIdSchema = z.enum(['monad', 'cli', 'web', 'tui']);
export type LicensePackageGroupId = z.infer<typeof licensePackageGroupIdSchema>;

export const licensePackageGroupSchema = z.object({
  id: licensePackageGroupIdSchema,
  packages: z.array(licenseEntrySchema)
});
export type LicensePackageGroup = z.infer<typeof licensePackageGroupSchema>;

export const getLicensesResponseSchema = z.object({
  packages: z.array(licenseEntrySchema),
  packageGroups: z.array(licensePackageGroupSchema),
  avatarStyles: z.array(avatarStyleCreditSchema)
});
export type GetLicensesResponse = z.infer<typeof getLicensesResponseSchema>;
