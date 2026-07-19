import { z } from 'zod';

import { agentObservationEventSchema } from '../agent-observation.ts';
import { externalAgentSessionIdSchema } from '../ids.ts';
import { externalAgentProviderSchema } from './external-agent-config.ts';

// The raw observation plane. `data` is the exact accepted provider frame (a string for live text
// transports) or the exact native record returned by the adapter's raw history reader. Monad adds
// only routing/ordering metadata; it never normalizes `data`. Raw delivery happens before
// parseOutput / projectLive / merge / dedupe. Raw endpoints are privileged diagnostic surfaces.
// `z.custom` (not `z.unknown`) so the key must be PRESENT while still accepting any value — a
// provider frame whose payload is legitimately `null`/`0`/`''` is preserved, but a missing frame
// is rejected. See docs/plans/2026-07-18-chat-experience-realtime-planes-design.md §Raw contract.
export const externalAgentRawFrameSchema = z.object({
  externalAgentSessionId: externalAgentSessionIdSchema,
  provider: externalAgentProviderSchema,
  observationEpoch: z.string().min(1).optional(),
  origin: z.enum(['live', 'history']),
  cursor: z.string().min(1),
  providerIdentity: z.string().min(1).optional(),
  stream: z.enum(['stdout', 'stderr', 'pty', 'app-server']).optional(),
  data: z.custom<unknown>((value) => value !== undefined),
  observedAt: z.string().optional()
});
export type ExternalAgentRawFrame = z.infer<typeof externalAgentRawFrameSchema>;

export const externalAgentRawHistoryRecordSchema = z.object({
  cursor: z.string().min(1).optional(),
  providerIdentity: z.string().min(1).optional(),
  data: z.custom<unknown>((value) => value !== undefined),
  observedAt: z.string().optional()
});
export type ExternalAgentRawHistoryRecord = z.infer<typeof externalAgentRawHistoryRecordSchema>;

// A page of exact provider-native history records. `coverage: 'exact'` means the provider history is
// authoritative for the requested records; `'settled'` means it exposes settled session records but
// not every transient transport delta. After the live epoch ends, Monad is strictly equal to what
// provider history exposes — it never synthesizes missing transient frames.
export const externalAgentRawHistoryPageSchema = z.object({
  records: z.array(externalAgentRawHistoryRecordSchema),
  nextCursor: z.string().min(1).optional(),
  coverage: z.enum(['exact', 'settled'])
});
export type ExternalAgentRawHistoryPage = z.infer<typeof externalAgentRawHistoryPageSchema>;

// The convenience plane: a deterministic projection of the same committed raw frame into Monad's
// neutral AgentObservationEvent contract, delivered as incremental upsert/remove — never a full list
// per tick. Stable event identity lets a later raw delta update a merged reasoning/tool item.
// `upsert.event` requires non-empty provenance (enforced by agentObservationEventSchema), so a
// projection can never claim an event with no raw grounding.
export const externalAgentConvenienceFrameSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ready'),
    observationEpoch: z.string().min(1).optional(),
    historyBefore: z.string().min(1).optional()
  }),
  z.object({
    kind: z.literal('upsert'),
    cursor: z.string().min(1),
    event: agentObservationEventSchema
  }),
  z.object({
    kind: z.literal('remove'),
    cursor: z.string().min(1),
    eventId: z.string().min(1)
  }),
  z.object({
    kind: z.literal('unavailable'),
    reason: z.string()
  })
]);
export type ExternalAgentConvenienceFrame = z.infer<typeof externalAgentConvenienceFrameSchema>;

// The race-free bootstrap handshake for the Observation panel: the current connection state plus a
// monotonic `revision` so a client that subscribes-first-then-refetches can reconcile the snapshot
// against control lifecycle events without assuming arrival order. `historyBefore` is the epoch's
// history/live join boundary. See design §Client State Machines (Observation panel).
export const externalAgentConnectionSnapshotSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('connected'),
    externalAgentSessionId: externalAgentSessionIdSchema,
    provider: externalAgentProviderSchema,
    observationEpoch: z.string().min(1),
    historyBefore: z.string().min(1).optional(),
    revision: z.number().int().nonnegative()
  }),
  z.object({
    state: z.literal('disconnected'),
    externalAgentSessionId: externalAgentSessionIdSchema,
    provider: externalAgentProviderSchema.optional(),
    revision: z.number().int().nonnegative()
  })
]);
export type ExternalAgentConnectionSnapshot = z.infer<typeof externalAgentConnectionSnapshotSchema>;
