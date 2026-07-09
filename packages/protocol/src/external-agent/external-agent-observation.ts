import { z } from 'zod';

import { agentObservationEventSchema } from '../agent-observation.ts';
import { externalAgentSessionIdSchema, nativeAgentDeliveryIdSchema } from '../ids.ts';
import { externalAgentProviderSchema } from './external-agent-config.ts';

export const externalAgentObservationRoleSchema = z.enum(['agent', 'system', 'tool', 'user']);
export type ExternalAgentObservationRole = z.infer<typeof externalAgentObservationRoleSchema>;

export const externalAgentObservationEventSchema = z.object({
  id: z.string().min(1),
  role: externalAgentObservationRoleSchema,
  text: z.string().min(1),
  source: z.enum([
    'codex-exec',
    'codex-app-server',
    'claude-code-sdk',
    'qwen-code-sdk',
    'gemini-cli',
    'plain-text',
    'unknown'
  ]),
  providerEventType: z.string().optional(),
  createdAt: z.string().optional(),
  raw: z.unknown().optional()
});
export type ExternalAgentObservationEvent = z.infer<typeof externalAgentObservationEventSchema>;

export const externalAgentUsageLimitMeterRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  percent: z.number(),
  meterPercent: z.number().optional(),
  resetLabel: z.string().optional(),
  valueLabel: z.string().optional()
});
export type ExternalAgentUsageLimitMeterRow = z.infer<typeof externalAgentUsageLimitMeterRowSchema>;

export const externalAgentUsageLimitMeterSchema = z.object({
  title: z.string(),
  rows: z.array(externalAgentUsageLimitMeterRowSchema)
});
export type ExternalAgentUsageLimitMeter = z.infer<typeof externalAgentUsageLimitMeterSchema>;

export const nativeAgentTurnPointerSchema = z.object({
  providerSessionRef: z.string().nullable().optional(),
  providerTurnId: z.string().nullable().optional()
});
export type NativeAgentTurnPointer = z.infer<typeof nativeAgentTurnPointerSchema>;

export const nativeAgentObservationRequestSchema = z
  .object({
    deliveryId: nativeAgentDeliveryIdSchema.optional(),
    externalAgentSessionId: externalAgentSessionIdSchema.optional()
  })
  .refine((request) => request.deliveryId !== undefined || request.externalAgentSessionId !== undefined, {
    message: 'deliveryId or externalAgentSessionId is required'
  });
export type NativeAgentObservationRequest = z.infer<typeof nativeAgentObservationRequestSchema>;

export const nativeAgentObservationProjectionSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('live'),
    externalAgentSessionId: externalAgentSessionIdSchema,
    deliveryId: nativeAgentDeliveryIdSchema.optional(),
    turn: nativeAgentTurnPointerSchema.optional(),
    provider: externalAgentProviderSchema,
    events: z.array(externalAgentObservationEventSchema),
    observedAt: z.string()
  }),
  z.object({
    state: z.literal('history'),
    externalAgentSessionId: externalAgentSessionIdSchema,
    deliveryId: nativeAgentDeliveryIdSchema.optional(),
    turn: nativeAgentTurnPointerSchema.optional(),
    provider: externalAgentProviderSchema,
    events: z.array(externalAgentObservationEventSchema),
    observedAt: z.string()
  }),
  z.object({
    state: z.literal('unavailable'),
    externalAgentSessionId: externalAgentSessionIdSchema.optional(),
    deliveryId: nativeAgentDeliveryIdSchema.optional(),
    turn: nativeAgentTurnPointerSchema.optional(),
    provider: externalAgentProviderSchema.optional(),
    reason: z.string()
  })
]);
export type NativeAgentObservationProjection = z.infer<typeof nativeAgentObservationProjectionSchema>;

/** Bytes retained from an external agent output snapshot. The daemon bounds its in-memory buffer and the
 *  SQLite column to this, and a client that folds `append` deltas must bound its accumulator to the
 *  same cap so it never renders more tail than the daemon retains. Cross-tier contract. */
export const EXTERNAL_AGENT_OUTPUT_SNAPSHOT_MAX = 256 * 1024;

export const externalAgentObservationAccessResponseSchema = z.discriminatedUnion('state', [
  // A live observation frame is either a full snapshot (`output`, sent first and on resync) or an
  // incremental delta (`append`, the text produced since `seq - append.length`). `seq` is the
  // cumulative output length after this frame — the consumer's cursor: it replaces on `output`, and
  // on `append` applies only the tail past its current cursor (deltas may overlap a just-taken
  // snapshot). This lets the stream push per-token deltas instead of the whole 256 KB buffer each tick.
  z.object({
    state: z.literal('live'),
    externalAgentSessionId: externalAgentSessionIdSchema,
    deliveryId: nativeAgentDeliveryIdSchema.optional(),
    turn: nativeAgentTurnPointerSchema.optional(),
    provider: externalAgentProviderSchema,
    output: z.string().optional(),
    append: z.string().optional(),
    seq: z.number().int().nonnegative().optional(),
    // Server-normalized cards for the `output` full-snapshot case (same adapter as parseOutput) — the
    // daemon knows the provider unambiguously, so the client renders these instead of re-deriving
    // them. Omitted on `append`-only delta frames: a delta has no self-contained context to normalize.
    events: z.array(externalAgentObservationEventSchema).optional(),
    // Same reasoning as `events`, for the provider's usage/rate-limit hints embedded in `output`.
    usageMeter: externalAgentUsageLimitMeterSchema.nullable().optional(),
    observedAt: z.string()
  }),
  z.object({
    state: z.literal('history'),
    externalAgentSessionId: externalAgentSessionIdSchema,
    deliveryId: nativeAgentDeliveryIdSchema.optional(),
    turn: nativeAgentTurnPointerSchema.optional(),
    provider: externalAgentProviderSchema,
    output: z.string(),
    events: z.array(externalAgentObservationEventSchema).optional(),
    usageMeter: externalAgentUsageLimitMeterSchema.nullable().optional(),
    observedAt: z.string()
  }),
  z.object({
    state: z.literal('unavailable'),
    externalAgentSessionId: externalAgentSessionIdSchema,
    deliveryId: nativeAgentDeliveryIdSchema.optional(),
    turn: nativeAgentTurnPointerSchema.optional(),
    provider: externalAgentProviderSchema.optional(),
    reason: z.string()
  })
]);
export type ExternalAgentObservationAccessResponse = z.infer<typeof externalAgentObservationAccessResponseSchema>;

// The neutral UI plane. Where the raw access response streams provider bytes (`output`/`append`) and
// leaves the consumer to re-derive cards from deltas, a ui frame carries the FULL neutral event list
// re-projected server-side every frame. The consumer replaces its list by event id — no delta math.
// `seq` mirrors the raw plane's output cursor so a reconnecting client resumes at the same point.
export const externalAgentUiObservationFrameSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('live'),
    externalAgentSessionId: externalAgentSessionIdSchema,
    deliveryId: nativeAgentDeliveryIdSchema.optional(),
    turn: nativeAgentTurnPointerSchema.optional(),
    provider: externalAgentProviderSchema,
    events: z.array(agentObservationEventSchema),
    seq: z.number().int().nonnegative().optional(),
    observedAt: z.string()
  }),
  z.object({
    state: z.literal('history'),
    externalAgentSessionId: externalAgentSessionIdSchema,
    deliveryId: nativeAgentDeliveryIdSchema.optional(),
    turn: nativeAgentTurnPointerSchema.optional(),
    provider: externalAgentProviderSchema,
    events: z.array(agentObservationEventSchema),
    observedAt: z.string()
  }),
  z.object({
    state: z.literal('unavailable'),
    externalAgentSessionId: externalAgentSessionIdSchema,
    deliveryId: nativeAgentDeliveryIdSchema.optional(),
    turn: nativeAgentTurnPointerSchema.optional(),
    provider: externalAgentProviderSchema.optional(),
    reason: z.string()
  })
]);
export type ExternalAgentUiObservationFrame = z.infer<typeof externalAgentUiObservationFrameSchema>;

export const managedExternalAgentLifecycleLogEventSchema = z.enum([
  'project.managed_external_agent.member_start_error',
  'project.managed_external_agent.resume_failed_cold_start',
  'project.managed_external_agent.delivery_error',
  'project.managed_external_agent.direct_delivery_error'
]);
export type ManagedExternalAgentLifecycleLogEvent = z.infer<typeof managedExternalAgentLifecycleLogEventSchema>;
