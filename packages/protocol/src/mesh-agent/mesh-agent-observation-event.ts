import { z } from 'zod';

import {
  agentObservationProgressSchema,
  agentObservationToolSchema,
  agentObservationTurnEndReasonSchema
} from '../agent-observation.ts';
import { agentObservationDiagnosticSchema } from '../agent-observation-diagnostic.ts';

export const meshAgentObservationRoleSchema = z.enum(['agent', 'system', 'tool', 'user']);
export type MeshAgentObservationRole = z.infer<typeof meshAgentObservationRoleSchema>;

const meshAgentObservationRawProvenanceSchema = z.object({
  rawEvents: z.array(z.custom<unknown>((event) => event !== undefined)).nonempty()
});

// The adapter owns its provider's tool vocabulary, so it normalizes the tool fields itself rather
// than leaving the shared neutral projection to recover them from `provenance.rawEvents`. Derived
// from the neutral tool shape so the two cannot drift; `category` is applied later by the
// projector's `toolCategory` hook.
export const meshAgentObservationToolSchema = agentObservationToolSchema.omit({ category: true }).partial();
export type MeshAgentObservationTool = z.infer<typeof meshAgentObservationToolSchema>;

export const meshAgentObservationEventSchema = z.object({
  id: z.string().min(1),
  dedupeKey: z.string().min(1).optional(),
  projection: z.enum(['normalized', 'unknown']).optional(),
  role: meshAgentObservationRoleSchema,
  text: z.string().min(1),
  source: z.enum([
    'codex-exec',
    'codex-app-server',
    'claude-code-sdk',
    'qwen-code-sdk',
    'gemini-cli',
    'antigravity-cli',
    'monad-app-server',
    'plain-text',
    'unknown'
  ]),
  providerEventType: z.string().optional(),
  diagnostic: agentObservationDiagnosticSchema.optional(),
  durationMs: z.number().nonnegative().optional(),
  hasContent: z.boolean().optional(),
  summary: z.string().min(1).optional(),
  createdAt: z.string().optional(),
  tool: meshAgentObservationToolSchema.optional(),
  progress: agentObservationProgressSchema.optional(),
  // Why a terminal event ended the turn. The adapter maps its own stop/subtype vocabulary; absent on
  // a terminal event means `completed`.
  turnEndReason: agentObservationTurnEndReasonSchema.optional(),
  provenance: meshAgentObservationRawProvenanceSchema
});
export type MeshAgentObservationEvent = z.infer<typeof meshAgentObservationEventSchema>;
