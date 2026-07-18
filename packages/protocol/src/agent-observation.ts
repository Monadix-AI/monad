import { z } from 'zod';

import { agentObservationDiagnosticSchema } from './agent-observation-diagnostic.ts';

export type { AgentObservationDiagnostic } from './agent-observation-diagnostic.ts';

export { agentObservationDiagnosticSchema } from './agent-observation-diagnostic.ts';

// Agent-kind-neutral observation event: the single contract an adapter's decode step produces
// (a raw provider frame → this) and every observation experience renders. It serves external
// agents today and generalizes to the monad built-in agent and ACP agents — hence "agent", not
// "external-agent". Deliberately UI-agnostic: no display roles, no pre-formatted text, no
// provider event-type strings. System/transport failure is signalled by the stream terminating
// (onError / terminal frame), never an in-band event, so there is no `error`/`system` kind.

export const agentObservationKindSchema = z.enum([
  'turn-start',
  'user-message',
  'reasoning',
  'tool-call',
  'tool-result',
  'assistant-message',
  'turn-end',
  'system',
  'unknown'
]);
export type AgentObservationKind = z.infer<typeof agentObservationKindSchema>;

// Why a turn settled. `error` is a turn OUTCOME (the agent's turn itself failed), distinct from a
// transport failure — the latter ends the stream instead of emitting an event.
export const agentObservationTurnEndReasonSchema = z.enum([
  'completed',
  'aborted',
  'error',
  'length',
  'content-filter'
]);
export type AgentObservationTurnEndReason = z.infer<typeof agentObservationTurnEndReasonSchema>;

export const agentObservationToolSchema = z.object({
  name: z.string().min(1),
  callId: z.string().min(1).optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  cwd: z.string().optional(),
  status: z.string().optional(),
  exitCode: z.number().int().optional(),
  durationMs: z.number().nonnegative().optional()
});
export type AgentObservationTool = z.infer<typeof agentObservationToolSchema>;

export const agentObservationProvenanceSchema = z.object({
  contractEvents: z.array(z.unknown()).nonempty()
});
export type AgentObservationProvenance = z.infer<typeof agentObservationProvenanceSchema>;

// One flat shape keyed by `kind`; field presence is by kind (the adapter decode sets only what a
// kind carries): `text` for reasoning / user-message / assistant-message, `tool` for
// tool-call / tool-result, `reason` for turn-end. `turn-start` carries none of them.
export const agentObservationEventSchema = z.object({
  id: z.string().min(1),
  dedupeKey: z.string().min(1).optional(),
  kind: agentObservationKindSchema,
  // A streaming fragment (a token/delta of a larger message) vs a settled event. Consumers
  // coalesce consecutive streaming fragments of the same kind into one rendered block.
  streaming: z.boolean(),
  // Raw model text — never pre-formatted for a specific surface.
  text: z.string().optional(),
  tool: agentObservationToolSchema.optional(),
  diagnostic: agentObservationDiagnosticSchema.optional(),
  reason: agentObservationTurnEndReasonSchema.optional(),
  provenance: agentObservationProvenanceSchema,
  // Provider-supplied event time (ISO 8601), when available.
  at: z.string().optional()
});
export type AgentObservationEvent = z.infer<typeof agentObservationEventSchema>;

// Token / rate-limit usage for a turn. A SEPARATE frame from the event stream — usage is not an
// observation `kind`; it updates out-of-band as the provider reports it.
export const agentObservationUsageLimitSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  // Fraction of the limit consumed, 0..1.
  percent: z.number().min(0),
  resetAt: z.string().optional()
});
export type AgentObservationUsageLimit = z.infer<typeof agentObservationUsageLimitSchema>;

export const agentObservationUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  limits: z.array(agentObservationUsageLimitSchema).optional()
});
export type AgentObservationUsage = z.infer<typeof agentObservationUsageSchema>;
