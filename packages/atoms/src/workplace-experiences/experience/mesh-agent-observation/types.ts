import { z } from 'zod';

// A pre-formatted usage/rate-limit dashboard widget (progress-bar rows with display labels) built
// from the neutral `AgentObservationUsage` (`@monad/protocol`'s `agent-observation.ts`). Presentation
// only — the daemon never produces or parses this — so it lives in the experience layer, next to the
// `meshAgentUsageLimitMeter()` builder that constructs it.
export const meshAgentUsageLimitMeterRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  percent: z.number(),
  meterPercent: z.number().optional(),
  resetLabel: z.string().optional(),
  valueLabel: z.string().optional()
});
export type MeshAgentUsageLimitMeterRow = z.infer<typeof meshAgentUsageLimitMeterRowSchema>;

export const meshAgentUsageLimitMeterSchema = z.object({
  title: z.string(),
  rows: z.array(meshAgentUsageLimitMeterRowSchema)
});
export type MeshAgentUsageLimitMeter = z.infer<typeof meshAgentUsageLimitMeterSchema>;
