import type { AvatarStyle } from './avatar.ts';

import { z } from 'zod';

import { AVATAR_STYLES, DEFAULT_AVATAR_STYLE } from './avatar.ts';

export const userAvatarDataUrlSchema = z
  .string()
  .max(768 * 1024)
  .regex(/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/);

const avatarStyleValues = AVATAR_STYLES.map((style) => style.slug) as [AvatarStyle, ...AvatarStyle[]];
export const avatarStyleSchema = z.enum(avatarStyleValues);

export const userProfileSettingsSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  avatarDataUrl: userAvatarDataUrlSchema.nullable(),
  avatarStyle: avatarStyleSchema.default(DEFAULT_AVATAR_STYLE)
});
export type UserProfileSettings = z.infer<typeof userProfileSettingsSchema>;

export const setUserProfileSettingsRequestSchema = userProfileSettingsSchema;
export type SetUserProfileSettingsRequest = z.infer<typeof setUserProfileSettingsRequestSchema>;
