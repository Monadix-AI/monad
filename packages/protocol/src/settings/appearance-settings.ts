import { z } from 'zod';

import { avatarStyleSchema, DEFAULT_AVATAR_STYLE } from '../avatar.ts';

export const composerSendShortcutSchema = z.enum(['enter', 'mod-enter-for-multiline', 'mod-enter-always']);
export type ComposerSendShortcut = z.infer<typeof composerSendShortcutSchema>;

export const composerFollowUpBehaviorSchema = z.enum(['queue', 'steer']);
export type ComposerFollowUpBehavior = z.infer<typeof composerFollowUpBehaviorSchema>;

export const DEFAULT_COMPOSER_SETTINGS = {
  followUpBehavior: 'queue',
  sendShortcut: 'enter'
} as const satisfies {
  followUpBehavior: ComposerFollowUpBehavior;
  sendShortcut: ComposerSendShortcut;
};

export const composerSettingsSchema = z
  .object({
    followUpBehavior: composerFollowUpBehaviorSchema.default(DEFAULT_COMPOSER_SETTINGS.followUpBehavior),
    sendShortcut: composerSendShortcutSchema.default(DEFAULT_COMPOSER_SETTINGS.sendShortcut)
  })
  .default(DEFAULT_COMPOSER_SETTINGS);
export type ComposerSettings = z.infer<typeof composerSettingsSchema>;

// App-wide presentation settings — not tied to any individual user's profile, and not
// restart-required (see monadSystemConfigSchema vs monadProfileSchema in @monad/environment).
export const appearanceSettingsSchema = z.object({
  avatarStyle: avatarStyleSchema.default(DEFAULT_AVATAR_STYLE),
  composer: composerSettingsSchema
});
export type AppearanceSettings = z.infer<typeof appearanceSettingsSchema>;

export const setAppearanceSettingsRequestSchema = appearanceSettingsSchema;
export type SetAppearanceSettingsRequest = z.infer<typeof setAppearanceSettingsRequestSchema>;
