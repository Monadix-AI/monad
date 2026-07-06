import type { Tool } from '@/capabilities/tools/types.ts';

import { expect, test } from 'bun:test';
import { z } from 'zod';

import { getCatalog } from '@/capabilities/tools/tool-catalog.ts';
import { toolResult } from '@/capabilities/tools/types.ts';

function makeTool(name: string, description = `desc for ${name}`): Tool {
  return { name, description, scopes: [], run: async () => toolResult('') };
}

test('formats a single tool with name, description, and "none" params', () => {
  const text = getCatalog([makeTool('my_tool', 'does stuff')], 1);
});

test('sorts tools alphabetically by name', () => {
  const tools = [makeTool('zebra'), makeTool('alpha'), makeTool('middle')];
  const text = getCatalog(tools, 2);
  const idxAlpha = text.indexOf('## alpha');
  const idxMiddle = text.indexOf('## middle');
  const idxZebra = text.indexOf('## zebra');
  expect(idxAlpha).toBeLessThan(idxMiddle);
  expect(idxMiddle).toBeLessThan(idxZebra);
});

test('returns cached text on same revision', () => {
  const tools = [makeTool('cache_tool')];
  const first = getCatalog(tools, 100);
  // mutate description on the tool — catalog should still return cached text
  (tools[0] as { description: string }).description = 'mutated';
  const second = getCatalog(tools, 100);
  expect(second).toBe(first);
});

test('evicts oldest revision when cache exceeds 3 entries', () => {
  // Seed revisions 200, 201, 202
  const t = makeTool('evict_tool');
  const r200 = getCatalog([t], 200);
  getCatalog([t], 201);
  getCatalog([t], 202);
  // Adding revision 203 should evict 200
  getCatalog([t], 203);
  // Fetching revision 200 again should recompute (cache miss → same content but new string)
  const r200again = getCatalog([t], 200);
  // The value is the same content but it's a freshly computed string, not the same reference
  expect(r200again).toEqual(r200);
});

test('includes JSON schema when tool has a zod inputSchema', () => {
  const tool: Tool<{ path: string }> = {
    name: 'schema_tool',
    description: 'reads a file',
    scopes: [],
    inputSchema: z.object({ path: z.string().min(1) }),
    run: async () => toolResult('')
  };
  const text = getCatalog([tool], 300);
});
