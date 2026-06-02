// L2 extraction: one LLM pass over a conversation span → entities + relations. Kept separate from
// the store + the consolidation loop so it's unit-testable with a fake `complete`.

interface ExtractedNode {
  name: string;
  type?: string;
  aliases?: string[];
}
interface ExtractedEdge {
  src: string; // references an entity name
  dst: string;
  relation: string;
  confidence?: number;
}
export interface ExtractedGraph {
  nodes: ExtractedNode[];
  edges: ExtractedEdge[];
}

/** Resolves a model id for a span's scope; returns the raw completion text for the two prompts. */
export type Complete = (model: string, system: string, user: string) => Promise<string>;

const EXTRACT_SYSTEM = (
  await Bun.file(new URL('../../../agent/prompts/memory-graph-extract-system-prompt.md', import.meta.url)).text()
).trim();

/** Pull the first balanced top-level JSON object out of model text and validate the shape. */
export function parseExtracted(text: string): ExtractedGraph | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as { entities?: unknown; relations?: unknown };
  const entities = Array.isArray(o.entities) ? o.entities : [];
  const relations = Array.isArray(o.relations) ? o.relations : [];

  const nodes: ExtractedNode[] = [];
  for (const e of entities) {
    if (typeof e !== 'object' || e === null) continue;
    const n = e as Record<string, unknown>;
    if (typeof n.name !== 'string' || !n.name.trim()) continue;
    nodes.push({
      name: n.name.trim(),
      type: typeof n.type === 'string' ? n.type : undefined,
      aliases: Array.isArray(n.aliases) ? n.aliases.filter((a): a is string => typeof a === 'string') : undefined
    });
  }

  const edges: ExtractedEdge[] = [];
  for (const r of relations) {
    if (typeof r !== 'object' || r === null) continue;
    const e = r as Record<string, unknown>;
    if (typeof e.src !== 'string' || typeof e.dst !== 'string' || typeof e.relation !== 'string') continue;
    if (!e.src.trim() || !e.dst.trim() || !e.relation.trim()) continue;
    edges.push({
      src: e.src.trim(),
      dst: e.dst.trim(),
      relation: e.relation.trim(),
      confidence: typeof e.confidence === 'number' ? Math.max(0, Math.min(1, e.confidence)) : undefined
    });
  }
  return { nodes, edges };
}

export async function extractGraph(
  complete: Complete,
  model: string,
  transcript: string
): Promise<ExtractedGraph | null> {
  const text = await complete(model, EXTRACT_SYSTEM, transcript);
  return parseExtracted(text);
}
