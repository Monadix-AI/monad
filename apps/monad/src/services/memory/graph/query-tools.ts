// The agent-facing L2 query tools, modeled on CodeGraph's explore/node split: `graph_explore` finds
// entities by a query and returns the relations among them; `graph_node` returns one entity and its
// neighbours. Read-only, scoped to the calling agent (+ global). Pulled on demand — never injected.

import type { Tool, ToolContext, ToolInputSchema } from '#/capabilities/tools/types.ts';
import type { GraphEdge, GraphNode, L2Provider } from './types.ts';

import { toolResult } from '#/capabilities/tools/types.ts';

/** Resolve the read scopes for a session (its agent scope + global). Injected so it's testable. */
export type GraphScopesFor = (sessionId: string) => string[];

interface QueryInput {
  query: string;
}

const queryInput = (key: 'query' | 'entity', desc: string): ToolInputSchema<QueryInput> => ({
  safeParse: (input) => {
    const o = (input ?? {}) as Record<string, unknown>;
    const v = o[key];
    if (typeof v !== 'string' || !v.trim()) return { success: false, error: new Error(`"${key}" is required`) };
    return { success: true, data: { query: v.trim() } };
  },
  toJsonSchema: () => ({
    type: 'object',
    properties: { [key]: { type: 'string', description: desc } },
    required: [key]
  })
});

function edgeLine(e: GraphEdge, nameOf: (id: string) => string): string {
  const prov = e.provClass === 'user' ? ', user' : '';
  return `- ${nameOf(e.src)} —[${e.relation}]→ ${nameOf(e.dst)} (${e.confidence.toFixed(2)}${prov})`;
}

function nodeLabel(n: GraphNode): string {
  const t = n.type ? ` (${n.type})` : '';
  const a = n.aliases.length ? ` [aka ${n.aliases.join(', ')}]` : '';
  return `${n.name}${t}${a}`;
}

export function createGraphQueryTools(store: L2Provider, scopesFor: GraphScopesFor): Tool[] {
  const explore: Tool<QueryInput, string> = {
    name: 'graph_explore',
    description:
      'Search your knowledge graph for entities matching a query (people, projects, tools, etc.) and ' +
      'see the relations connecting them. Use this to recall who/what is related and how.',
    scopes: [{ resource: 'memory:read' }],
    inputSchema: queryInput('query', 'What to look up — entity names or keywords (e.g. "deployment tooling")'),
    inputExamples: [{ query: 'monad' }],
    run: async (input, ctx: ToolContext) => {
      const scopes = scopesFor(ctx.sessionId);
      const nodes = store.searchNodes(scopes, input.query);
      if (nodes.length === 0) return toolResult(`No matching entities for "${input.query}".`);
      const nameOf = new Map(nodes.map((n) => [n.id, n.name]));
      const edges = store.edgesAmong(nodes.map((n) => n.id));
      const lines = [`Entities matching "${input.query}":`, ...nodes.map((n) => `- ${nodeLabel(n)}`)];
      if (edges.length) {
        lines.push('Relations among them:', ...edges.map((e) => edgeLine(e, (id) => nameOf.get(id) ?? id)));
      }
      return toolResult(lines.join('\n'));
    }
  };

  const node: Tool<QueryInput, string> = {
    name: 'graph_node',
    description:
      'Look up one entity by name in your knowledge graph and list its direct relations (neighbours). ' +
      'Use after graph_explore to drill into a specific entity.',
    scopes: [{ resource: 'memory:read' }],
    inputSchema: queryInput('entity', 'The exact entity name to inspect (e.g. "Monad")'),
    inputExamples: [{ query: 'Monad' }],
    run: async (input, ctx: ToolContext) => {
      const scopes = scopesFor(ctx.sessionId);
      const n = store.getNode(scopes, input.query);
      if (!n) return toolResult(`No entity named "${input.query}".`);
      const edges = store.edgesFor(n.id);
      const otherIds = [...new Set(edges.flatMap((e) => [e.src, e.dst]))];
      const nameOf = new Map(store.nodesByIds(otherIds).map((x) => [x.id, x.name]));
      const lines = [nodeLabel(n)];
      if (edges.length) lines.push('Relations:', ...edges.map((e) => edgeLine(e, (id) => nameOf.get(id) ?? id)));
      else lines.push('(no relations recorded yet)');
      return toolResult(lines.join('\n'));
    }
  };

  return [explore, node];
}
