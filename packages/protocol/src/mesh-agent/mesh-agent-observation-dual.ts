import { z } from 'zod';

import { agentObservationEventSchema } from '../agent-observation.ts';
import { meshSessionIdSchema } from '../ids.ts';
import { normalizeQueryStringValue } from '../pagination.ts';
import { meshAgentProviderSchema } from './mesh-agent-config.ts';
import { observationCursorSchema } from './observation-cursor.ts';

// The raw observation plane. `data` is the exact accepted provider frame (a string for live text
// transports) or the exact native record returned by the adapter's raw events reader. Monad adds
// only routing/ordering metadata; it never normalizes `data`. Raw delivery happens before
// parseOutput / projectLive / merge / dedupe. Raw endpoints are privileged diagnostic surfaces.
// `z.custom` (not `z.unknown`) so the key must be PRESENT while still accepting any value — a
// provider frame whose payload is legitimately `null`/`0`/`''` is preserved, but a missing frame
// is rejected. See docs/plans/2026-07-18-chat-experience-realtime-planes-design.md §Raw contract.
export const meshRawEventSchema = z.object({
  meshSessionId: meshSessionIdSchema,
  provider: meshAgentProviderSchema,
  observationEpoch: z.string().min(1).optional(),
  origin: z.enum(['live', 'events']),
  cursor: observationCursorSchema,
  providerIdentity: z.string().min(1).optional(),
  stream: z.enum(['stdout', 'stderr']).optional(),
  data: z.custom<unknown>((value) => value !== undefined),
  observedAt: z.string().optional()
});
export type MeshRawEvent = z.infer<typeof meshRawEventSchema>;

export const meshRawEventRecordSchema = z.object({
  cursor: z.string().min(1).optional(),
  providerIdentity: z.string().min(1).optional(),
  data: z.custom<unknown>((value) => value !== undefined),
  observedAt: z.string().optional()
});
export type MeshRawEventRecord = z.infer<typeof meshRawEventRecordSchema>;

// A page of exact provider-native event records. `coverage: 'exact'` means the provider event source is
// authoritative for the requested records; `'settled'` means it exposes settled session records but
// not every transient transport delta. After the live epoch ends, Monad is strictly equal to what
// provider events expose — it never synthesizes missing transient frames.
export const meshRawEventPageSchema = z.object({
  records: z.array(meshRawEventRecordSchema),
  nextCursor: z.string().min(1).optional(),
  coverage: z.enum(['exact', 'settled'])
});
export type MeshRawEventPage = z.infer<typeof meshRawEventPageSchema>;

// One projected change. `event.id` is the entity identity a consumer merges/keys on; it is never a
// position (see observation-cursor.ts). `upsert.event` requires non-empty provenance (enforced by
// agentObservationEventSchema), so a projection can never claim an event with no raw grounding.
export const meshConvenienceOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('upsert'), event: agentObservationEventSchema }),
  z.object({ op: z.literal('remove'), eventId: z.string().min(1) })
]);
export type MeshConvenienceOperation = z.infer<typeof meshConvenienceOperationSchema>;

// The convenience plane: a deterministic projection of the same committed raw frame into Monad's
// neutral AgentObservationEvent contract, delivered as incremental patches — never a full list per
// tick.
//
// A patch is ATOMIC: one raw position can project to several operations, and the SSE frame is the
// only delivery unit SSE never splits. Emitting one frame per operation would let a client that
// drops mid-batch resume at `> cursor` and silently lose the rest of that batch. `cursor` is the
// highest raw position whose consumption is fully reflected in the patch, so resuming from it
// re-consumes only rows the client has not seen applied. Operations apply in array order and are
// idempotent by `event.id`, so a replay (stale epoch, retained-state miss) is safe.
export const meshConvenienceFrameSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ready'),
    observationEpoch: z.string().min(1).optional(),
    // The resume anchor a client holds before any patch arrives; also what re-anchors it after a
    // stale-epoch replay.
    cursor: observationCursorSchema.optional(),
    eventsBefore: observationCursorSchema.optional()
  }),
  z.object({
    kind: z.literal('patch'),
    cursor: observationCursorSchema,
    operations: z.array(meshConvenienceOperationSchema).min(1)
  }),
  z.object({
    kind: z.literal('unavailable'),
    reason: z.string()
  })
]);
export type MeshConvenienceFrame = z.infer<typeof meshConvenienceFrameSchema>;

export const meshConvenienceEventPageSchema = z.object({
  frames: z.array(meshConvenienceFrameSchema),
  nextCursor: observationCursorSchema.optional()
});
export type MeshConvenienceEventPage = z.infer<typeof meshConvenienceEventPageSchema>;

// The race-free bootstrap handshake for the Observation panel: the current connection state plus a
// monotonic `revision` so a client that subscribes-first-then-refetches can reconcile the snapshot
// against control lifecycle events without assuming arrival order. `eventsBefore` is the epoch's
// earlier/live join boundary. See design §Client State Machines (Observation panel).
export const meshConnectionSnapshotSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('connected'),
    meshSessionId: meshSessionIdSchema,
    provider: meshAgentProviderSchema,
    observationEpoch: z.string().min(1),
    eventsBefore: observationCursorSchema.optional(),
    revision: z.number().int().nonnegative()
  }),
  z.object({
    state: z.literal('disconnected'),
    meshSessionId: meshSessionIdSchema,
    provider: meshAgentProviderSchema.optional(),
    revision: z.number().int().nonnegative()
  })
]);
export type MeshConnectionSnapshot = z.infer<typeof meshConnectionSnapshotSchema>;

export const meshEventPageRequestSchema = z.object({
  view: z.enum(['raw', 'convenience']),
  before: z.preprocess(normalizeQueryStringValue, observationCursorSchema).optional(),
  limit: z.coerce.number().int().positive().max(100).default(20)
});
export type MeshEventPageRequest = z.infer<typeof meshEventPageRequestSchema>;

export const meshEventPageSchema = z.discriminatedUnion('view', [
  meshRawEventPageSchema.extend({ view: z.literal('raw') }),
  meshConvenienceEventPageSchema.extend({ view: z.literal('convenience') })
]);
export type MeshEventPage = z.infer<typeof meshEventPageSchema>;
