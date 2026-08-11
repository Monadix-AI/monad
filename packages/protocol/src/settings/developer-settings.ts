import { z } from 'zod';

import { iso8601Schema, meshSessionIdSchema, projectIdSchema, projectMemberIdSchema, sessionIdSchema } from '../ids.ts';
import { meshAgentProviderSchema } from '../mesh-agent/mesh-agent-config.ts';

export const developerLogAutoCleanupSchema = z
  .object({
    enabled: z.boolean(),
    retentionDays: z.number().int().min(1).max(30)
  })
  .strict();

export const developerSettingsSchema = z
  .object({
    developerMode: z.boolean(),
    logsDir: z.string(),
    logs: z
      .object({
        autoCleanup: developerLogAutoCleanupSchema
      })
      .strict()
  })
  .strict();
export type DeveloperSettings = z.infer<typeof developerSettingsSchema>;

export const setDeveloperSettingsRequestSchema = z
  .object({
    developerMode: z.boolean().optional(),
    logs: z
      .object({
        autoCleanup: developerLogAutoCleanupSchema.optional()
      })
      .strict()
      .optional()
  })
  .strict();
export type SetDeveloperSettingsRequest = z.infer<typeof setDeveloperSettingsRequestSchema>;

export const previewLogCleanupRequestSchema = developerLogAutoCleanupSchema;
export type PreviewLogCleanupRequest = z.infer<typeof previewLogCleanupRequestSchema>;

export const logCleanupPreviewSchema = z
  .object({
    files: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative()
  })
  .strict();
export type LogCleanupPreview = z.infer<typeof logCleanupPreviewSchema>;

export const logCleanupResultSchema = z
  .object({
    filesCleared: z.number().int().nonnegative(),
    filesFailed: z.number().int().nonnegative(),
    bytesFreed: z.number().int().nonnegative()
  })
  .strict();
export type LogCleanupResult = z.infer<typeof logCleanupResultSchema>;

export const liveEventReplayCaptureSchema = z
  .object({
    projectId: projectIdSchema,
    projectName: z.string().min(1).optional(),
    sessionId: sessionIdSchema,
    sessionTitle: z.string().min(1).optional(),
    projectMemberId: projectMemberIdSchema,
    memberName: z.string().min(1),
    meshSessionId: meshSessionIdSchema,
    provider: meshAgentProviderSchema,
    observationEpoch: z.string().min(1),
    startedAt: iso8601Schema,
    updatedAt: iso8601Schema,
    frames: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative()
  })
  .strict();
export type LiveEventReplayCapture = z.infer<typeof liveEventReplayCaptureSchema>;

export const listLiveEventReplayCapturesResponseSchema = z
  .object({ captures: z.array(liveEventReplayCaptureSchema) })
  .strict();
export type ListLiveEventReplayCapturesResponse = z.infer<typeof listLiveEventReplayCapturesResponseSchema>;

export const liveEventReplayFrameSchema = z
  .object({
    seq: z.number().int().positive(),
    stream: z.enum(['stdout', 'stderr']),
    payload: z.string(),
    observedAt: iso8601Schema
  })
  .strict();
export type LiveEventReplayFrame = z.infer<typeof liveEventReplayFrameSchema>;

export const getLiveEventReplayFramesParamsSchema = z
  .object({
    meshSessionId: meshSessionIdSchema,
    observationEpoch: z.string().min(1)
  })
  .strict();

export const getLiveEventReplayFramesQuerySchema = z
  .object({
    offset: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().min(1).max(5_000).default(1_000)
  })
  .strict();
export type GetLiveEventReplayFramesQuery = z.infer<typeof getLiveEventReplayFramesQuerySchema>;

export const liveEventReplayFramePageSchema = z
  .object({
    frames: z.array(liveEventReplayFrameSchema),
    total: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive()
  })
  .strict();
export type LiveEventReplayFramePage = z.infer<typeof liveEventReplayFramePageSchema>;
