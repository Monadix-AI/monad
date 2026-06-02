import { z } from 'zod';

const sessionModelSelectionSchema = z
  .object({
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional()
  })
  .strict();

export type SessionModelSelection = z.infer<typeof sessionModelSelectionSchema>;

export function serializeSessionModelSelection(selection: SessionModelSelection): string | null {
  const parsed = sessionModelSelectionSchema.parse(selection);
  if (!parsed.model && !parsed.effort) return null;
  return JSON.stringify(parsed);
}

export function parseSessionModelSelection(raw: string | null): SessionModelSelection {
  if (raw === null) return {};
  if (!raw.trimStart().startsWith('{')) return sessionModelSelectionSchema.parse({ model: raw });
  return sessionModelSelectionSchema.parse(JSON.parse(raw));
}
