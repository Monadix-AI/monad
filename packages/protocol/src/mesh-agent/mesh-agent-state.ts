import type { Event, EventType } from '../domain.ts';

import { z } from 'zod';

import {
  eventSchema,
  MESH_AGENT_NAME_MAX,
  MESH_APPROVAL_TEXT_MAX,
  MESH_LOGIN_REASON_MAX,
  MESH_REF_MAX,
  MESH_WORKING_PATH_MAX,
  meshApprovalDataWithinBudget
} from '../event-table.ts';
import { eventIdSchema, iso8601Schema, meshSessionIdSchema } from '../ids.ts';

// Max entries in one authoritative snapshot per collection. A session with more than this many live
// mesh sessions / pending logins / pending approvals is already pathological; the bound keeps a
// schema-valid snapshot's encoded size under the SSE byte-bounded queue.
export const MESH_SNAPSHOT_ARRAY_MAX = 128;
export const MESH_SNAPSHOT_LIFECYCLE_EVENTS_MAX = 64;

import { meshAgentProviderSchema } from './mesh-agent-config.ts';
import { meshSessionViewSchema } from './mesh-session.ts';

export const meshAgentStateSessionSchema = meshSessionViewSchema
  .omit({ productIcon: true })
  .extend({
    agentName: z.string().max(MESH_AGENT_NAME_MAX),
    workingPath: z.string().max(MESH_WORKING_PATH_MAX),
    agentRuntimeId: z.string().max(MESH_REF_MAX).nullable().optional(),
    providerSessionRef: z.string().max(MESH_REF_MAX).nullable().optional()
  })
  .strict();
export type MeshAgentStateSession = z.infer<typeof meshAgentStateSessionSchema>;

export const meshAgentLoginRequirementSchema = z
  .object({
    // id is derived from URL-encoded agent names, so bound it above the name bound to allow escaping.
    id: z
      .string()
      .min(1)
      .max(MESH_AGENT_NAME_MAX * 4),
    observedAt: iso8601Schema,
    agentName: z.string().min(1).max(MESH_AGENT_NAME_MAX),
    authAgentName: z.string().min(1).max(MESH_AGENT_NAME_MAX),
    provider: meshAgentProviderSchema,
    meshSessionId: meshSessionIdSchema.optional(),
    reason: z.string().min(1).max(MESH_LOGIN_REASON_MAX)
  })
  .strict();
export type MeshAgentLoginRequirement = z.infer<typeof meshAgentLoginRequirementSchema>;

export const meshAgentPendingApprovalSchema = z
  .object({
    requestId: z.string().min(1).max(MESH_REF_MAX),
    meshSessionId: meshSessionIdSchema,
    provider: meshAgentProviderSchema,
    text: z.string().max(MESH_APPROVAL_TEXT_MAX),
    data: z.unknown().refine(meshApprovalDataWithinBudget, 'approval data exceeds the size budget').optional(),
    requestedAt: iso8601Schema
  })
  .strict();
export type MeshAgentPendingApproval = z.infer<typeof meshAgentPendingApprovalSchema>;

export const meshAgentStateLifecycleEventSchema = eventSchema.and(
  z.object({ type: z.enum(['mesh.idle_suspended', 'mesh.idle_resumed']) })
);
export type MeshAgentStateLifecycleEvent = z.infer<typeof meshAgentStateLifecycleEventSchema>;

export const meshAgentStateSnapshotSchema = z
  .object({
    kind: z.literal('snapshot'),
    cursor: eventIdSchema.optional(),
    sessions: z.array(meshAgentStateSessionSchema).max(MESH_SNAPSHOT_ARRAY_MAX),
    loginRequirements: z.array(meshAgentLoginRequirementSchema).max(MESH_SNAPSHOT_ARRAY_MAX),
    approvals: z.array(meshAgentPendingApprovalSchema).max(MESH_SNAPSHOT_ARRAY_MAX),
    lifecycleEvents: z.array(meshAgentStateLifecycleEventSchema).max(MESH_SNAPSHOT_LIFECYCLE_EVENTS_MAX).optional()
  })
  .strict();
export type MeshAgentStateSnapshot = z.infer<typeof meshAgentStateSnapshotSchema>;

export type MeshAgentStateEvent = Event & { type: Extract<EventType, `mesh.${string}`> };

export function isMeshAgentStateEvent(event: Event): event is MeshAgentStateEvent {
  return event.type.startsWith('mesh.');
}

export const meshAgentStateEventSchema = eventSchema.refine(isMeshAgentStateEvent, {
  message: 'Expected a canonical mesh event'
});

export const meshAgentStateFrameSchema = z.discriminatedUnion('kind', [
  meshAgentStateSnapshotSchema,
  z.object({ kind: z.literal('event'), event: meshAgentStateEventSchema }).strict(),
  z.object({ kind: z.literal('unavailable'), reason: z.literal('mesh-agent-service-unavailable') }).strict()
]);
export type MeshAgentStateFrame = z.infer<typeof meshAgentStateFrameSchema>;

// Total encoded-size budget for one mesh-state frame. Kept under the SSE byte-bounded queue cap
// (SSE_MAX_QUEUED_BYTES = 4 MiB) with headroom for the SSE framing wrapper, so a frame the estimator
// admits is guaranteed not to overflow the queue when encoded.
export const MESH_STATE_FRAME_BUDGET_BYTES = 3_500_000;

// Conservative UPPER BOUND on a value's JSON-encoded UTF-8 size WITHOUT serializing it (serializing
// would allocate the very bytes this guards against). Each UTF-16 code unit encodes to at most 6 JSON
// bytes (a control char → `\uXXXX`), which also covers every multi-byte character and JSON escape.
function jsonBytesUpperBound(value: unknown): number {
  if (typeof value === 'string') return value.length * 6 + 2;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return 8;
  if (Array.isArray(value)) return 2 + value.reduce((total: number, item) => total + jsonBytesUpperBound(item) + 1, 0);
  if (typeof value === 'object') {
    return (
      2 +
      Object.entries(value as Record<string, unknown>).reduce(
        (total, [key, item]) => total + key.length * 6 + jsonBytesUpperBound(item) + 4,
        0
      )
    );
  }
  return 8;
}

// True when a frame's guaranteed-upper-bound encoded size fits the budget. Covers EVERY frame kind and
// every field (the whole frame is walked), so it can never miss an unbounded string like a giant
// session workingPath or a live event payload. The canonical field bounds keep a legitimate frame well
// under the budget; an over-budget frame is rejected before encode and surfaced as `unavailable`.
export function meshStateFrameWithinBudget(frame: MeshAgentStateFrame): boolean {
  return jsonBytesUpperBound(frame) <= MESH_STATE_FRAME_BUDGET_BYTES;
}

export function meshAgentLoginRequirementId(agentName: string, authAgentName: string): string {
  return `mesh-login:${encodeURIComponent(agentName)}:${encodeURIComponent(authAgentName)}`;
}
