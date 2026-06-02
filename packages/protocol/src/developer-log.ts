import { z } from 'zod';

export const developerLogRecordSchema = z.looseObject({
  level: z.number(),
  time: z.number().optional(),
  name: z.string().optional(),
  msg: z.string().optional(),
  sessionId: z.string().optional(),
  channelId: z.string().optional(),
  event: z.string().optional()
});

export type DeveloperLogRecord = z.infer<typeof developerLogRecordSchema>;
