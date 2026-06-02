import { z } from 'zod';

export type EventCursor = `cur_${string}`;

const EVENT_CURSOR_PAYLOAD_MAX_BYTES = 1024;

export const eventCursorSchema: z.ZodType<EventCursor> = z
  .string()
  .regex(/^cur_[A-Za-z0-9_-]+$/)
  .refine((value) => value.length - 4 <= EVENT_CURSOR_PAYLOAD_MAX_BYTES) as z.ZodType<EventCursor>;
