import type { Tool } from '#/capabilities/tools/types.ts';

import { toolInputJsonSchema } from '#/capabilities/tools/schema.ts';

// Module-level cache keyed by toolRevision plus the visible tool names; survives AgentLoop reconstruction across turns
// without reusing one agent's filtered catalog for another agent.
// Ring-eviction: keep at most 3 revisions to bound memory.
const cache = new Map<string, string>();

function formatTool(tool: Tool): string {
  const schema = toolInputJsonSchema(tool);
  const params = schema ? JSON.stringify(schema, null, 2) : 'none';
  return `## ${tool.name}\nDescription: ${tool.description}\nParameters:\n${params}`;
}

export function getCatalog(tools: Tool[], revision: number): string {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const key = `${revision}:${sorted.map((tool) => tool.name).join('\0')}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const text = sorted.map(formatTool).join('\n\n---\n\n');

  cache.set(key, text);

  if (cache.size > 3) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }

  return text;
}
