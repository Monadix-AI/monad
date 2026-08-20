import { z } from 'zod';

const FENCE = /```research-desk\s*([\s\S]*?)```/g;

const crossReadAnswerSchema = z.object({
  record: z.literal('crossread-answer'),
  answer: z.string().min(1).max(20_000),
  citations: z
    .array(
      z.object({
        sourceId: z.string().min(1).max(200),
        excerpt: z.string().min(1).max(4_000),
        locator: z.string().min(1).max(200).optional()
      })
    )
    .max(50)
    .default([])
});

const runCompleteSchema = z.object({
  record: z.literal('run-complete'),
  runId: z.string().min(1).max(200),
  tokens: z.number().int().nonnegative().optional(),
  cost: z.object({ amount: z.number(), currency: z.string().min(1).max(10) }).optional(),
  failureReason: z.string().min(1).max(2_000).optional()
});

const meshPayloadSchema = z.discriminatedUnion('record', [crossReadAnswerSchema, runCompleteSchema]);

export type MeshPayload = z.infer<typeof meshPayloadSchema>;
export type CrossReadAnswerPayload = z.infer<typeof crossReadAnswerSchema>;
export type RunCompletePayload = z.infer<typeof runCompleteSchema>;

/** The mesh half of the fenced-block protocol. Same rule as the three-pane ingest: an agent reports
 *  into the workspace by emitting structured blocks, never by calling the Experience API — a model
 *  that could call the API could rule on its own reading. */
export function parseMeshPayloads(text: string): MeshPayload[] {
  const payloads: MeshPayload[] = [];
  for (const match of text.matchAll(FENCE)) {
    const raw = match[1];
    if (!raw) continue;
    try {
      const parsed = meshPayloadSchema.safeParse(JSON.parse(raw));
      if (parsed.success) payloads.push(parsed.data);
    } catch {
      // Malformed blocks are transcript noise, not a reason to fail the turn.
    }
  }
  return payloads;
}

export function citationsFor(payload: CrossReadAnswerPayload): Array<{
  sourceId: string;
  excerpt: string;
  locator: string | null;
}> {
  return payload.citations.map((citation) => ({
    sourceId: citation.sourceId,
    excerpt: citation.excerpt,
    locator: citation.locator ?? null
  }));
}
