import { z } from 'zod';

import { iso8601Schema, projectIdSchema, projectMemberIdSchema } from '../ids.ts';
import { workplaceProjectMemberSettingsSchema, workplaceProjectMemberTypeSchema } from './mesh-agent-workplace.ts';

export const projectMemberLifecycleSchema = z.enum(['enabled', 'disabled']);
export type ProjectMemberLifecycle = z.infer<typeof projectMemberLifecycleSchema>;

export const projectMemberLaunchOverridesSchema = workplaceProjectMemberSettingsSchema.omit({
  cwd: true,
  customPrompt: true
});
export type ProjectMemberLaunchOverrides = z.infer<typeof projectMemberLaunchOverridesSchema>;

export const projectMemberSchema = z
  .object({
    id: projectMemberIdSchema,
    projectId: projectIdSchema,
    profileId: z.string().min(1),
    type: workplaceProjectMemberTypeSchema,
    displayName: z.string().min(1),
    customPrompt: z.string().nullable().default(null),
    launchOverrides: projectMemberLaunchOverridesSchema.default({}),
    workingDirectoryOverride: z.string().min(1).nullable().default(null),
    lifecycle: projectMemberLifecycleSchema.default('enabled'),
    createdAt: iso8601Schema,
    updatedAt: iso8601Schema
  })
  .strict();
export type ProjectMember = z.infer<typeof projectMemberSchema>;
