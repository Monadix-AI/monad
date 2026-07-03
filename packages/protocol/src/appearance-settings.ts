import { z } from 'zod';

import { avatarStyleSchema, DEFAULT_AVATAR_STYLE } from './avatar.ts';

// App-wide presentation settings — not tied to any individual user's profile, and not
// restart-required (see monadSystemConfigSchema vs monadProfileSchema in @monad/home).
export const appearanceSettingsSchema = z.object({
  avatarStyle: avatarStyleSchema.default(DEFAULT_AVATAR_STYLE)
});
export type AppearanceSettings = z.infer<typeof appearanceSettingsSchema>;

export const setAppearanceSettingsRequestSchema = appearanceSettingsSchema;
export type SetAppearanceSettingsRequest = z.infer<typeof setAppearanceSettingsRequestSchema>;
