import { z } from 'zod';

export const userAvatarDataUrlSchema = z
  .string()
  .max(768 * 1024)
  .regex(/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/);

export const userProfileSettingsSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  avatarDataUrl: userAvatarDataUrlSchema.nullable()
});
export type UserProfileSettings = z.infer<typeof userProfileSettingsSchema>;

export const setUserProfileSettingsRequestSchema = userProfileSettingsSchema;
export type SetUserProfileSettingsRequest = z.infer<typeof setUserProfileSettingsRequestSchema>;
