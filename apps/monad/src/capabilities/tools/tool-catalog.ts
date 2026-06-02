import type { Tool } from '@/capabilities/tools/types.ts';

import { toolInputJsonSchema } from '@/capabilities/tools/schema.ts';

// Module-level cache keyed by toolRevision; survives AgentLoop reconstruction across turns.
// Ring-eviction: keep at most 3 revisions to bound memory.
const cache = new Map<number, string>();

function formatTool(tool: Tool): string {
  const schema = toolInputJsonSchema(tool);
  const params = schema ? JSON.stringify(schema, null, 2) : 'none';
  return `## ${tool.name}\nDescription: ${tool.description}\nParameters:\n${params}`;
}

export function getCatalog(tools: Tool[], revision: number): string {
  const hit = cache.get(revision);
  if (hit !== undefined) return hit;

  const text = [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(formatTool)
    .join('\n\n---\n\n');

  cache.set(revision, text);

  if (cache.size > 3) {
    const oldest = Math.min(...cache.keys());
    cache.delete(oldest);
  }

  return text;
}
