import { z } from 'zod';

export const systemUpgradeStageSchema = z.enum([
  'idle',
  'checking',
  'downloading',
  'verifying',
  'installing',
  'restarting',
  'complete',
  'failed'
]);
export type SystemUpgradeStage = z.infer<typeof systemUpgradeStageSchema>;

export const systemUpgradeStatusSchema = z.object({
  available: z.boolean(),
  currentVersion: z.string(),
  latestVersion: z.string().nullable(),
  stage: systemUpgradeStageSchema,
  progress: z.number().min(0).max(100),
  error: z.string().nullable()
});
export type SystemUpgradeStatus = z.infer<typeof systemUpgradeStatusSchema>;
