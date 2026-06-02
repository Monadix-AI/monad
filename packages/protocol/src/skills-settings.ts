import { z } from 'zod';

export const skillsSettingsResponseSchema = z.object({
  /** Global master switch for automatic model-context skill loading. */
  autoload: z.boolean(),
  /** Skill instance ids fully disabled for both automatic loading and manual invocation. */
  disabled: z.array(z.string()),
  /** Skill instance ids kept available for manual invocation but excluded from automatic model-context loading. */
  autoloadDisabled: z.array(z.string()),
  /** Run a model-backed review before installing remotely-fetched skills. */
  installReview: z.boolean(),
  /** Whether the current config has a usable model for install review. */
  installReviewAvailable: z.boolean()
});
export type SkillsSettingsResponse = z.infer<typeof skillsSettingsResponseSchema>;

export const setSkillsSettingsRequestSchema = z.object({
  /** Global master switch for automatic model-context skill loading. */
  autoload: z.boolean().optional(),
  /** Replace skill instance ids fully disabled for both automatic loading and manual invocation. */
  disabled: z.array(z.string()).optional(),
  /** Replace skill instance ids kept available manually but excluded from automatic model-context loading. */
  autoloadDisabled: z.array(z.string()).optional(),
  /** Run a model-backed review before installing remotely-fetched skills. */
  installReview: z.boolean().optional()
});
export type SetSkillsSettingsRequest = z.infer<typeof setSkillsSettingsRequestSchema>;
