import { z } from 'zod';

import { agentObservationDiagnosticSchema } from '../agent-observation-diagnostic.ts';

export const externalAgentObservationRoleSchema = z.enum(['agent', 'system', 'tool', 'user']);
export type ExternalAgentObservationRole = z.infer<typeof externalAgentObservationRoleSchema>;

const externalAgentObservationRawProvenanceSchema = z.object({
  rawEvents: z.array(z.custom<unknown>((event) => event !== undefined)).nonempty()
});

export const externalAgentObservationEventSchema = z.object({
  id: z.string().min(1),
  dedupeKey: z.string().min(1).optional(),
  projection: z.enum(['normalized', 'unknown']).optional(),
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
  diagnostic: agentObservationDiagnosticSchema.optional(),
  createdAt: z.string().optional(),
  provenance: externalAgentObservationRawProvenanceSchema
});
export type ExternalAgentObservationEvent = z.infer<typeof externalAgentObservationEventSchema>;
