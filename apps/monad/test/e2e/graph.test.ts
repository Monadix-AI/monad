// e2e: the L2 knowledge-graph read endpoint (GET /v1/graph) over both transports. Seeds a GraphStore,
// serves the daemon HTTP app, and asserts the wire view round-trips entities + current relations.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { GraphStore } from '#/services/memory/graph/store.ts';
import { createHttpTransport } from '#/transports/http.ts';
import { buildHandlers, mockModel, serveTransport, TRANSPORTS, type TransportHandle } from '../helpers.ts';

for (const kind of TRANSPORTS) {
  describe(`graph endpoint over ${kind}`, () => {
    let t: TransportHandle;
    let graph: GraphStore;

    beforeEach(() => {
      graph = new GraphStore(':memory:');
      const a = graph.upsertNode({ scope: 'agent:agt_A00000000000', name: 'Zeke', type: 'person' });
      const b = graph.upsertNode({
        scope: 'agent:agt_A00000000000',
        name: 'Monad',
        type: 'project',
        aliases: ['the daemon']
      });
      graph.upsertEdge({
        scope: 'agent:agt_A00000000000',
        src: a,
        dst: b,
        relation: 'works_on',
        provClass: 'machine',
        support: ['m1'],
        confidence: 0.8
      });
      graph.upsertNode({ scope: 'agent:agt_B00000000000', name: 'Other Agent Fact', type: 'fact' });
      t = serveTransport(kind, createHttpTransport(buildHandlers(mockModel(), undefined, { graphStore: graph })));
    });

    afterEach(async () => {
      await t.stop();
    });

    test('GET /v1/graph returns the entities and current relations', async () => {
      const res = await t.fetch('/v1/graph');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        nodes: { id: string; name: string; type: string | null; aliases: string[]; scope: string }[];
        edges: { src: string; dst: string; relation: string; confidence: number; provClass: string }[];
      };
      expect(body.nodes.map((n) => n.name).sort()).toEqual(['Monad', 'Other Agent Fact', 'Zeke']);
      const monad = body.nodes.find((n) => n.name === 'Monad');
      expect(monad?.type).toBe('project');
      expect(monad?.aliases).toEqual(['the daemon']);

      expect(body.edges).toHaveLength(1);
      const edge = body.edges[0];
      expect(edge?.relation).toBe('works_on');
      expect(edge?.confidence).toBeCloseTo(0.8);
      // the edge's endpoints are real node ids in the snapshot
      const nodeIds = new Set(body.nodes.map((n) => n.id));
      expect(nodeIds.has(edge?.src ?? '')).toBe(true);
      expect(nodeIds.has(edge?.dst ?? '')).toBe(true);
    });

    test('GET /v1/graph isolates an Agent scope before returning nodes and edges', async () => {
      const res = await t.fetch('/v1/graph?scopeKind=agent&scopeId=agt_A00000000000');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        nodes: { name: string; scope: string }[];
        edges: { scope: string; relation: string }[];
      };
      expect(body).toEqual({
        nodes: expect.arrayContaining([
          expect.objectContaining({ name: 'Zeke', scope: 'agent:agt_A00000000000' }),
          expect.objectContaining({ name: 'Monad', scope: 'agent:agt_A00000000000' })
        ]),
        edges: [expect.objectContaining({ scope: 'agent:agt_A00000000000', relation: 'works_on' })]
      });
      expect(body.nodes.map((node) => node.name).sort()).toEqual(['Monad', 'Zeke']);
    });

    test('a retracted edge is absent from the snapshot', async () => {
      graph.reconcile(() => false); // all support dead → edge retracted
      const body = (await (await t.fetch('/v1/graph')).json()) as { edges: unknown[] };
      expect(body.edges).toHaveLength(0);
    });
  });
}
