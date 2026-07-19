import { z } from 'zod';

import { agentObservationDiagnosticSchema } from '../agent-observation-diagnostic.ts';

export const meshAgentObservationRoleSchema = z.enum(['agent', 'system', 'tool', 'user']);
export type MeshAgentObservationRole = z.infer<typeof meshAgentObservationRoleSchema>;

const meshAgentObservationRawProvenanceSchema = z.object({
  rawEvents: z.array(z.custom<unknown>((event) => event !== undefined)).nonempty()
});

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
    'plain-text',
    'unknown'
  ]),
  providerEventType: z.string().optional(),
  diagnostic: agentObservationDiagnosticSchema.optional(),
  createdAt: z.string().optional(),
  provenance: meshAgentObservationRawProvenanceSchema
});
export type MeshAgentObservationEvent = z.infer<typeof meshAgentObservationEventSchema>;
