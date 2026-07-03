import { z } from 'zod';

export const clarifyChoiceModeSchema = z.enum(['single', 'multiple']);
export type ClarifyChoiceMode = z.infer<typeof clarifyChoiceModeSchema>;

export const clarifyAskerSchema = z.object({
  id: z.string().optional(),
  name: z.string()
});
export type ClarifyAsker = z.infer<typeof clarifyAskerSchema>;
