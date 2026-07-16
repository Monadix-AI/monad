import { z } from 'zod';

import {
  sessionOriginExtSchema,
  sessionOriginSchema,
  sessionSchema,
  sessionStateSchema,
  sessionSurfaceSchema
} from './domain.ts';
import { workplaceProjectMemberTemplatesSchema } from './external-agent/external-agent-workplace.ts';
import { messageIdSchema, nativeAgentDeliveryIdSchema, projectIdSchema } from './ids.ts';
import { offsetPaginationQuerySchema, offsetPaginationResponseSchema, SESSION_TITLE_MAX } from './rpc/control.ts';

export const workplaceProjectSchema = z.object({
  id: projectIdSchema,
  title: z.string(),
  state: sessionStateSchema,
  archived: z.boolean(),
  model: z.string().optional(),
  cwd: z.string().optional(),
  origin: sessionOriginSchema.optional(),
  // Project-level preset catalog (Track B, decision 4) — config a session invites from; never
  // itself running anything. Distinct from a session's live session_members bindings.
  memberTemplates: workplaceProjectMemberTemplatesSchema.default([]),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type WorkplaceProject = z.infer<typeof workplaceProjectSchema>;

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

// A session under a project (Track B). No auto-created default (resolved decision 3) — this is the
// explicit entry point a project's UI calls to start its first (or an additional) session.
export const createProjectSessionRequestSchema = z.object({
  title: z.string().max(SESSION_TITLE_MAX),
  origin: createWorkplaceProjectOriginHintSchema.optional(),
  cwd: z.string().optional()
});
export type CreateProjectSessionRequest = z.infer<typeof createProjectSessionRequestSchema>;

export const createProjectSessionResponseSchema = z.object({ sessionId: sessionSchema.shape.id });
export type CreateProjectSessionResponse = z.infer<typeof createProjectSessionResponseSchema>;

export const listProjectSessionsQuerySchema = offsetPaginationQuerySchema;
export type ListProjectSessionsQuery = z.infer<typeof listProjectSessionsQuerySchema>;

export const listProjectSessionsResponseSchema = offsetPaginationResponseSchema.extend({
  sessions: z.array(sessionSchema)
});
export type ListProjectSessionsResponse = z.infer<typeof listProjectSessionsResponseSchema>;

export const getWorkplaceProjectResponseSchema = z.object({ project: workplaceProjectSchema });
export type GetWorkplaceProjectResponse = z.infer<typeof getWorkplaceProjectResponseSchema>;

export const updateWorkplaceProjectRequestSchema = z.object({
  title: z.string().max(SESSION_TITLE_MAX).optional(),
  state: sessionStateSchema.optional(),
  archived: z.boolean().optional(),
  model: z.string().nullable().optional(),
  cwd: z.string().nullable().optional(),
  origin: sessionOriginSchema.nullable().optional(),
  memberTemplates: workplaceProjectMemberTemplatesSchema.optional()
});
export type UpdateWorkplaceProjectRequest = z.infer<typeof updateWorkplaceProjectRequestSchema>;

export const updateWorkplaceProjectResponseSchema = z.object({ project: workplaceProjectSchema });
export type UpdateWorkplaceProjectResponse = z.infer<typeof updateWorkplaceProjectResponseSchema>;

export const deleteWorkplaceProjectResponseSchema = z.object({ deleted: z.literal(true) });
export type DeleteWorkplaceProjectResponse = z.infer<typeof deleteWorkplaceProjectResponseSchema>;

export const experienceParticipantTransportSchema = z.enum(['monad', 'acp', 'external-agent', 'custom']);
export type ExperienceParticipantTransport = z.infer<typeof experienceParticipantTransportSchema>;

export const experienceFanoutRecipientSchema = z.object({
  participantId: z.string().min(1),
  displayName: z.string().min(1).optional(),
  transport: experienceParticipantTransportSchema,
  runtimeId: z.string().min(1).optional()
});
export type ExperienceFanoutRecipient = z.infer<typeof experienceFanoutRecipientSchema>;

export const experienceFanoutRequestSchema = z.object({
  projectId: projectIdSchema,
  experienceId: z.string().min(1),
  triggerMessageId: messageIdSchema.optional(),
  triggerMessageSeq: z.number().int().nonnegative().optional(),
  recipients: z.array(experienceFanoutRecipientSchema).min(1),
  createdAt: z.string().optional()
});
export type ExperienceFanoutRequest = z.infer<typeof experienceFanoutRequestSchema>;

export const experienceProjectionEventSchema = z.object({
  id: z.string().min(1),
  projectId: projectIdSchema,
  experienceId: z.string().min(1),
  kind: z.enum(['system', 'message', 'thinking', 'ask', 'join', 'observation']),
  orderKey: z.union([z.string(), z.number()]),
  participantId: z.string().min(1).optional(),
  sourceDeliveryId: nativeAgentDeliveryIdSchema.optional(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string()
});
export type ExperienceProjectionEvent = z.infer<typeof experienceProjectionEventSchema>;
