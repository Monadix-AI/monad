import { z } from 'zod';

import { nativeAgentDeliveryIdSchema } from './ids.ts';
import { nativeCliProviderSchema } from './native-cli-agent-config.ts';

export const nativeCliObservationRoleSchema = z.enum(['agent', 'system', 'tool', 'user']);
export type NativeCliObservationRole = z.infer<typeof nativeCliObservationRoleSchema>;

export const nativeCliObservationEventSchema = z.object({
  id: z.string().min(1),
  role: nativeCliObservationRoleSchema,
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
export type NativeCliObservationEvent = z.infer<typeof nativeCliObservationEventSchema>;

export const nativeCliUsageLimitMeterRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  percent: z.number(),
  meterPercent: z.number().optional(),
  resetLabel: z.string().optional(),
  valueLabel: z.string().optional()
});
export type NativeCliUsageLimitMeterRow = z.infer<typeof nativeCliUsageLimitMeterRowSchema>;

export const nativeCliUsageLimitMeterSchema = z.object({
  title: z.string(),
  rows: z.array(nativeCliUsageLimitMeterRowSchema)
});
export type NativeCliUsageLimitMeter = z.infer<typeof nativeCliUsageLimitMeterSchema>;

export const nativeAgentTurnPointerSchema = z.object({
  providerSessionRef: z.string().nullable().optional(),
  providerTurnId: z.string().nullable().optional()
});
export type NativeAgentTurnPointer = z.infer<typeof nativeAgentTurnPointerSchema>;

export const nativeAgentObservationRequestSchema = z
  .object({
    deliveryId: nativeAgentDeliveryIdSchema.optional(),
    nativeCliSessionId: z
      .string()
      .regex(/^ncli_/)
      .optional()
  })
  .refine((request) => request.deliveryId !== undefined || request.nativeCliSessionId !== undefined, {
    message: 'deliveryId or nativeCliSessionId is required'
  });
export type NativeAgentObservationRequest = z.infer<typeof nativeAgentObservationRequestSchema>;

export const nativeAgentObservationProjectionSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('live'),
    nativeCliSessionId: z.string().regex(/^ncli_/),
    deliveryId: nativeAgentDeliveryIdSchema.optional(),
    turn: nativeAgentTurnPointerSchema.optional(),
    provider: nativeCliProviderSchema,
    events: z.array(nativeCliObservationEventSchema),
    observedAt: z.string()
  }),
  z.object({
    state: z.literal('history'),
    nativeCliSessionId: z.string().regex(/^ncli_/),
    deliveryId: nativeAgentDeliveryIdSchema.optional(),
    turn: nativeAgentTurnPointerSchema.optional(),
    provider: nativeCliProviderSchema,
    events: z.array(nativeCliObservationEventSchema),
    observedAt: z.string()
  }),
  z.object({
    state: z.literal('unavailable'),
    nativeCliSessionId: z
      .string()
      .regex(/^ncli_/)
      .optional(),
    deliveryId: nativeAgentDeliveryIdSchema.optional(),
    turn: nativeAgentTurnPointerSchema.optional(),
    provider: nativeCliProviderSchema.optional(),
    reason: z.string()
  })
]);
export type NativeAgentObservationProjection = z.infer<typeof nativeAgentObservationProjectionSchema>;

/** Bytes retained from a native-CLI output snapshot. The daemon bounds its in-memory buffer and the
 *  SQLite column to this, and a client that folds `append` deltas must bound its accumulator to the
 *  same cap so it never renders more tail than the daemon retains. Cross-tier contract. */
export const NATIVE_CLI_OUTPUT_SNAPSHOT_MAX = 256 * 1024;

export const nativeCliObservationAccessResponseSchema = z.discriminatedUnion('state', [
  // A live observation frame is either a full snapshot (`output`, sent first and on resync) or an
  // incremental delta (`append`, the text produced since `seq - append.length`). `seq` is the
  // cumulative output length after this frame — the consumer's cursor: it replaces on `output`, and
  // on `append` applies only the tail past its current cursor (deltas may overlap a just-taken
  // snapshot). This lets the stream push per-token deltas instead of the whole 256 KB buffer each tick.
  z.object({
    state: z.literal('live'),
    nativeCliSessionId: z.string().regex(/^ncli_/),
    deliveryId: nativeAgentDeliveryIdSchema.optional(),
    turn: nativeAgentTurnPointerSchema.optional(),
    provider: nativeCliProviderSchema,
    output: z.string().optional(),
    append: z.string().optional(),
    seq: z.number().int().nonnegative().optional(),
    // Server-normalized cards for the `output` full-snapshot case (same adapter as parseOutput) — the
    // daemon knows the provider unambiguously, so the client renders these instead of re-deriving
    // them. Omitted on `append`-only delta frames: a delta has no self-contained context to normalize.
    events: z.array(nativeCliObservationEventSchema).optional(),
    // Same reasoning as `events`, for the provider's usage/rate-limit hints embedded in `output`.
    usageMeter: nativeCliUsageLimitMeterSchema.nullable().optional(),
    observedAt: z.string()
  }),
  z.object({
    state: z.literal('history'),
    nativeCliSessionId: z.string().regex(/^ncli_/),
    deliveryId: nativeAgentDeliveryIdSchema.optional(),
    turn: nativeAgentTurnPointerSchema.optional(),
    provider: nativeCliProviderSchema,
    output: z.string(),
    events: z.array(nativeCliObservationEventSchema).optional(),
    usageMeter: nativeCliUsageLimitMeterSchema.nullable().optional(),
    observedAt: z.string()
  }),
  z.object({
    state: z.literal('unavailable'),
    nativeCliSessionId: z.string().regex(/^ncli_/),
    deliveryId: nativeAgentDeliveryIdSchema.optional(),
    turn: nativeAgentTurnPointerSchema.optional(),
    provider: nativeCliProviderSchema.optional(),
    reason: z.string()
  })
]);
export type NativeCliObservationAccessResponse = z.infer<typeof nativeCliObservationAccessResponseSchema>;

export const managedNativeCliLifecycleLogEventSchema = z.enum([
  'project.managed_native_cli.member_start_error',
  'project.managed_native_cli.resume_failed_cold_start',
  'project.managed_native_cli.delivery_error',
  'project.managed_native_cli.direct_delivery_error'
]);
export type ManagedNativeCliLifecycleLogEvent = z.infer<typeof managedNativeCliLifecycleLogEventSchema>;
