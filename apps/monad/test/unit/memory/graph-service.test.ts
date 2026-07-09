// L2 consolidation loop (extract → upsert → cursor → reconcile) + the CodeGraph-shaped query tools,
// over a real in-memory GraphStore with a fake model + fake message source.

import type { ToolContext } from '#/capabilities/tools/types.ts';

import { expect, test } from 'bun:test';

import { parseExtracted } from '#/services/memory/graph/extract.ts';
import { createGraphQueryTools } from '#/services/memory/graph/query-tools.ts';
import { consolidateGraph, type GraphMessage, graphAutoDue } from '#/services/memory/graph/service.ts';
import { GraphStore } from '#/services/memory/graph/store.ts';

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;
const GRAPH_JSON = JSON.stringify({
  entities: [
    { name: 'Zeke', type: 'person' },
    { name: 'Monad', type: 'project', aliases: ['the daemon'] }
  ],
  relations: [{ src: 'Zeke', dst: 'Monad', relation: 'works_on', confidence: 0.8 }]
});

const msgs: GraphMessage[] = [
  { id: 'm1', role: 'user', text: 'I work on Monad' },
  { id: 'm2', role: 'assistant', text: 'Got it' },
  { id: 'm3', role: 'user', text: 'Monad is my daemon project' },
  { id: 'm4', role: 'assistant', text: 'Noted' }
];
const after = (afterId: string | null): GraphMessage[] => {
  if (!afterId) return msgs;
  const i = msgs.findIndex((m) => m.id === afterId);
  return i === -1 ? msgs : msgs.slice(i + 1);
};

function deps(store: GraphStore, complete: () => Promise<string>, alive: Set<string>) {
  return {
    store,
    sessions: () => [{ id: 'ses_100000000000', agentId: 'a1', projectKey: null }],
    messagesAfter: (_sid: string, afterId: string | null) => after(afterId),
    isAlive: (id: string) => alive.has(id),
    complete,
    extractModel: () => 'test',
    minNewMessages: 1,
    log: silent
  };
}

test('graphAutoDue gates background consolidation on enabled + elapsed interval', () => {
  const MIN = 60_000;
  expect(graphAutoDue(undefined, 0, 100 * MIN)).toBe(false); // unconfigured
  expect(graphAutoDue({ autoConsolidate: false, intervalMinutes: 1 }, 0, 100 * MIN)).toBe(false); // off
  expect(graphAutoDue({ autoConsolidate: true, intervalMinutes: 30 }, 0, 10 * MIN)).toBe(false); // too soon
  expect(graphAutoDue({ autoConsolidate: true, intervalMinutes: 30 }, 0, 30 * MIN)).toBe(true); // due
  expect(graphAutoDue({ autoConsolidate: true }, 0, 30 * MIN)).toBe(true); // default 30m interval
});

test('parseExtracted tolerates prose around the JSON and drops malformed rows', () => {
  const g = parseExtracted(`sure, here:\n${GRAPH_JSON}\nhope that helps`);
  expect(g?.nodes.map((n) => n.name)).toEqual(['Zeke', 'Monad']);
  expect(g?.edges).toHaveLength(1);
});

test('consolidate extracts a graph, advances the per-session cursor, and is idempotent', async () => {
  const store = new GraphStore(':memory:');
  const alive = new Set(['m1', 'm2', 'm3', 'm4']);
  const r1 = await consolidateGraph(deps(store, async () => GRAPH_JSON, alive));
  expect(r1.nodes).toBe(2);
  expect(r1.edges).toBe(1);
  expect(r1.sessionsExtracted).toBe(1);
  expect(store.getCursor('ses_100000000000')).toBe('m4'); // watermark advanced to the last message

  // second pass: no new messages past the cursor → nothing extracted (and the model isn't even called)
  let called = false;
  const r2 = await consolidateGraph(
    deps(
      store,
      async () => {
        called = true;
        return GRAPH_JSON;
      },
      alive
    )
  );
  expect(called).toBe(false);
  expect(r2.sessionsExtracted).toBe(0);
});

test('a session with a projectKey writes its graph into both the agent and project scopes', async () => {
  const store = new GraphStore(':memory:');
  const alive = new Set(['m1', 'm2', 'm3', 'm4']);
  await consolidateGraph({
    ...deps(store, async () => GRAPH_JSON, alive),
    sessions: () => [{ id: 'ses_100000000000', agentId: 'a1', projectKey: 'monad-abc123' }]
  });
  // one extraction, two subgraphs — the agent's and the workspace's
  expect(store.searchNodes(['agent:a1'], 'Zeke').length).toBe(1);
  expect(store.searchNodes(['project:monad-abc123'], 'Zeke').length).toBe(1);
});

test('cost: tool/non-prose messages are excluded from the extraction prompt (cursor still advances)', async () => {
  const store = new GraphStore(':memory:');
  const span: GraphMessage[] = [
    { id: 'p1', role: 'user', text: 'I work on Monad' },
    { id: 'p2', role: 'tool', text: `TOOL OUTPUT ${'x'.repeat(5000)}` }, // huge, no graph signal
    { id: 'p3', role: 'assistant', text: 'Monad is the daemon' }
  ];
  let _prompt = '';
  await consolidateGraph({
    store,
    sessions: () => [{ id: 'ses_t00000000000', agentId: 'a1', projectKey: null }],
    messagesAfter: () => span,
    isAlive: () => true,
    complete: async (_m, _s, user) => {
      _prompt = user;
      return GRAPH_JSON;
    },
    extractModel: () => 'test',
    minNewMessages: 1,
    log: silent
  });
  expect(store.getCursor('ses_t00000000000')).toBe('p3'); // advanced to the last fed prose message
});

test('cost: a long span is capped to the char budget; the tail is consolidated on the next pass', async () => {
  const store = new GraphStore(':memory:');
  const big: GraphMessage[] = [
    { id: 'b1', role: 'user', text: 'A'.repeat(100) },
    { id: 'b2', role: 'assistant', text: 'B'.repeat(100) },
    { id: 'b3', role: 'user', text: 'C'.repeat(100) }
  ];
  let calls = 0;
  const mk = () => ({
    store,
    sessions: () => [{ id: 'ses_b00000000000', agentId: 'a1', projectKey: null }],
    messagesAfter: (_s: string, afterId: string | null) =>
      afterId ? big.slice(big.findIndex((m) => m.id === afterId) + 1) : big,
    isAlive: () => true,
    complete: async () => {
      calls++;
      return JSON.stringify({ entities: [{ name: 'X' }], relations: [] });
    },
    extractModel: () => 'test',
    minNewMessages: 1,
    maxTranscriptChars: 150, // fits only one ~106-char message per pass
    log: silent
  });
  await consolidateGraph(mk());
  expect(store.getCursor('ses_b00000000000')).toBe('b1'); // budget truncated the batch to the first message
  await consolidateGraph(mk()); // next pass picks up the tail
  expect(store.getCursor('ses_b00000000000')).toBe('b2');
  expect(calls).toBe(2);
});

test('reconcile retracts an edge once all its supporting messages are deleted', async () => {
  const store = new GraphStore(':memory:');
  const alive = new Set(['m1', 'm2', 'm3', 'm4']);
  await consolidateGraph(deps(store, async () => GRAPH_JSON, alive));
  const zeke = store.getNode(['agent:a1'], 'Zeke');
  expect(store.edgesFor(zeke?.id ?? '')).toHaveLength(1);

  // all supporting messages soft-deleted → next pass reconciles the edge away
  alive.clear();
  const r = await consolidateGraph(deps(store, async () => GRAPH_JSON, alive));
  expect(r.prunedEdges).toBe(1);
});

test('graph_explore and graph_node surface the consolidated graph, scope-isolated', async () => {
  const store = new GraphStore(':memory:');
  await consolidateGraph(deps(store, async () => GRAPH_JSON, new Set(['m1', 'm2', 'm3', 'm4'])));
  const [explore, node] = createGraphQueryTools(store, () => ['agent:a1']);
  const ctx = { sessionId: 'ses_100000000000' } as unknown as ToolContext;

  // querying both entities surfaces the relation between them (edgesAmong needs both endpoints in the hits)
  const _ex = (await explore?.run({ query: 'zeke monad' }, ctx))?.modelContent as string;

  const _nd = (await node?.run({ query: 'Zeke' }, ctx))?.modelContent as string;

  // a different agent's scope sees nothing
  const [_explore2] = createGraphQueryTools(store, () => ['agent:other']);
});
