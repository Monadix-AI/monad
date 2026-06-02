import { z } from 'zod';

// Read-only "mem0 explorer" wire view: every stored memory + a 2D projection of its embedding (for the
// cluster scatter), per-scope counts, and the vector-store status.

export const mem0EntrySchema = z.object({
  id: z.string(),
  scope: z.string(),
  text: z.string(),
  x: z.number().nullable(),
  y: z.number().nullable()
});
export type Mem0EntryView = z.infer<typeof mem0EntrySchema>;

export const getMem0DataResponseSchema = z.object({
  available: z.boolean(),
  vectorStore: z.string(),
  qdrant: z.object({ phase: z.string(), error: z.string().nullable() }).nullable(),
  total: z.number(),
  scopeCounts: z.array(z.object({ scope: z.string(), count: z.number() })),
  entries: z.array(mem0EntrySchema)
});
export type GetMem0DataResponse = z.infer<typeof getMem0DataResponseSchema>;
