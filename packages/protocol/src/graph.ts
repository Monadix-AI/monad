import { z } from 'zod';

// Wire view of the L2 knowledge graph for the read-only web viewer. The daemon flattens its SQLite
// store into these; the UI renders them (react-flow). Current edges only (validTo IS NULL).

export const graphNodeViewSchema = z.object({
  id: z.string(),
  scope: z.string(),
  name: z.string(),
  type: z.string().nullable(),
  aliases: z.array(z.string())
});
export type GraphNodeView = z.infer<typeof graphNodeViewSchema>;

export const graphEdgeViewSchema = z.object({
  id: z.string(),
  scope: z.string(),
  src: z.string(),
  dst: z.string(),
  relation: z.string(),
  provClass: z.enum(['machine', 'user']),
  confidence: z.number()
});
export type GraphEdgeView = z.infer<typeof graphEdgeViewSchema>;

export const getGraphResponseSchema = z.object({
  nodes: z.array(graphNodeViewSchema),
  edges: z.array(graphEdgeViewSchema)
});
export type GetGraphResponse = z.infer<typeof getGraphResponseSchema>;
