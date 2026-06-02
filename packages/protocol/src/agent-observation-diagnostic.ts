import { z } from 'zod';

export const agentObservationDiagnosticSchema = z.object({
  severity: z.enum(['warning', 'error']),
  message: z.string().min(1),
  detail: z.string().min(1).optional(),
  target: z.string().min(1).optional()
});
export type AgentObservationDiagnostic = z.infer<typeof agentObservationDiagnosticSchema>;
