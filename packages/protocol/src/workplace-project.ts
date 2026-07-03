import type { Session } from './domain.ts';

import { z } from 'zod';

import { offsetPaginationQuerySchema, offsetPaginationResponseSchema, SESSION_TITLE_MAX } from './control.ts';
import { sessionOriginExtSchema, sessionOriginSchema, sessionStateSchema, sessionSurfaceSchema } from './domain.ts';
import { principalIdSchema, projectIdSchema } from './ids.ts';

export const workplaceProjectSchema = z.object({
  id: projectIdSchema,
  title: z.string(),
  ownerPrincipalId: principalIdSchema,
  state: sessionStateSchema,
  archived: z.boolean(),
  model: z.string().optional(),
  cwd: z.string().optional(),
  origin: sessionOriginSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type WorkplaceProject = z.infer<typeof workplaceProjectSchema>;
export type TranscriptTarget = Session | WorkplaceProject;

export const createWorkplaceProjectOriginHintSchema = z.object({
  surface: sessionSurfaceSchema.optional(),
  clientVersion: z.string().max(100).optional(),
  ext: sessionOriginExtSchema.optional()
});
export type CreateWorkplaceProjectOriginHint = z.infer<typeof createWorkplaceProjectOriginHintSchema>;

export const createWorkplaceProjectRequestSchema = z.object({
  title: z.string().max(SESSION_TITLE_MAX),
  origin: createWorkplaceProjectOriginHintSchema.optional(),
  cwd: z.string().optional()
});
export type CreateWorkplaceProjectRequest = z.infer<typeof createWorkplaceProjectRequestSchema>;

export const createWorkplaceProjectResponseSchema = z.object({ projectId: projectIdSchema });
export type CreateWorkplaceProjectResponse = z.infer<typeof createWorkplaceProjectResponseSchema>;

export const listWorkplaceProjectsQuerySchema = offsetPaginationQuerySchema.extend({
  archived: z.boolean().optional(),
  state: sessionStateSchema.optional()
});
export type ListWorkplaceProjectsQuery = z.infer<typeof listWorkplaceProjectsQuerySchema>;

export const listWorkplaceProjectsResponseSchema = offsetPaginationResponseSchema.extend({
  projects: z.array(workplaceProjectSchema)
});
export type ListWorkplaceProjectsResponse = z.infer<typeof listWorkplaceProjectsResponseSchema>;

export const getWorkplaceProjectResponseSchema = z.object({ project: workplaceProjectSchema });
export type GetWorkplaceProjectResponse = z.infer<typeof getWorkplaceProjectResponseSchema>;

export const updateWorkplaceProjectRequestSchema = z.object({
  title: z.string().max(SESSION_TITLE_MAX).optional(),
  state: sessionStateSchema.optional(),
  archived: z.boolean().optional(),
  model: z.string().nullable().optional(),
  cwd: z.string().nullable().optional(),
  origin: sessionOriginSchema.nullable().optional()
});
export type UpdateWorkplaceProjectRequest = z.infer<typeof updateWorkplaceProjectRequestSchema>;

export const updateWorkplaceProjectResponseSchema = z.object({ project: workplaceProjectSchema });
export type UpdateWorkplaceProjectResponse = z.infer<typeof updateWorkplaceProjectResponseSchema>;

export const deleteWorkplaceProjectResponseSchema = z.object({ deleted: z.literal(true) });
export type DeleteWorkplaceProjectResponse = z.infer<typeof deleteWorkplaceProjectResponseSchema>;
