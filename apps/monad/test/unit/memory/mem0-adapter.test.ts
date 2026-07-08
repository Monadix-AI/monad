// Mem0Adapter over a fake Mem0Client — no SDK, no network. Verifies the mem0 mapping
// (search→recall, add→observe, getAll/add/delete facade).

import type { MemoryScope } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { Mem0Adapter, type Mem0Client, type Mem0Memory } from '#/services/memory/mem0.ts';

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;
const budget = { core: 0, facts: 2000, graph: 0, laws: 0 };

class FakeMem0 implements Mem0Client {
  store = new Map<string, Mem0Memory[]>();
  addCalls: { messages: { role: string; content: string }[]; userId?: string; infer?: boolean }[] = [];
  private next = 0;
  async add(messages: { role: string; content: string }[], opts: { userId?: string; infer?: boolean }) {
    this.addCalls.push({ messages, userId: opts.userId, infer: opts.infer });
    const m: Mem0Memory = { id: `m${this.next++}`, memory: messages.map((x) => x.content).join(' / ') };
    const arr = this.store.get(opts.userId ?? '') ?? [];
    arr.push(m);
    this.store.set(opts.userId ?? '', arr);
    return { results: [m] };
  }
  async search(_query: string, opts: { topK?: number; filters?: { user_id?: string } }) {
    return { results: this.store.get(opts.filters?.user_id ?? '') ?? [] };
  }
  async getAll(opts: { filters?: { user_id?: string } }) {
    return { results: this.store.get(opts.filters?.user_id ?? '') ?? [] };
  }
  async delete(id: string): Promise<{ message: string }> {
    for (const [k, arr] of this.store)
      this.store.set(
        k,
        arr.filter((m) => m.id !== id)
      );
    return { message: 'deleted' };
  }
}

test('capabilities: mem0 advertises vector search', () => {
  const a = new Mem0Adapter(new FakeMem0(), silent);
  expect(a.capabilities().vectorSearch).toBe(true);
});

test('observe forwards the exchange to mem0.add under the agent userId', async () => {
  const client = new FakeMem0();
  const a = new Mem0Adapter(client, silent);
  await a.observe(
    { user: 'I use Bun', assistant: 'noted' },
    { sessionId: 'ses_1', scope: { kind: 'agent', id: 'agt_1' } }
  );
  expect(client.addCalls).toHaveLength(1);
  expect(client.addCalls[0]?.userId).toBe('agent:agt_1'); // userId namespaced by kind
  expect(client.addCalls[0]?.messages.map((m) => m.content)).toEqual(['I use Bun', 'noted']);
});

test('recall searches every requested scope and merges (global facts no longer lost)', async () => {
  const client = new FakeMem0();
  await client.add([{ role: 'user', content: 'global fact' }], { userId: 'global' });
  await client.add([{ role: 'user', content: 'project fact' }], { userId: 'project:p1' });
  await client.add([{ role: 'user', content: 'agent fact' }], { userId: 'agent:agt_1' });
  const a = new Mem0Adapter(client, silent);
  const block = await a.recall({
    query: 'q',
    sessionId: 'ses_1',
    agentId: 'agt_1',
    scopes: [
      { kind: 'global', id: '*' },
      { kind: 'project', id: 'p1' },
      { kind: 'agent', id: 'agt_1' }
    ],
    advanced: false,
    budget
  });
  // Previously only the agent scope was searched, so "global fact"/"project fact" were never recalled.
  expect(block.facts.map((f) => f.content).sort()).toEqual(['agent fact', 'global fact', 'project fact']);
  expect(block.facts.map((f) => f.scope.kind).sort()).toEqual(['agent', 'global', 'project']);
});

test('facade: addFact (infer:false) / listFacts / forgetFact map to mem0', async () => {
  const client = new FakeMem0();
  const a = new Mem0Adapter(client, silent);
  const scope: MemoryScope = { kind: 'agent', id: 'agt_1' };
  const fact = await a.addFact(scope, 'User prefers tabs');
  expect(fact?.provClass).toBe('user');
  expect(client.addCalls[0]?.infer).toBe(false);
  expect((await a.listFacts(scope)).map((f) => f.content)).toEqual(['User prefers tabs']);
  const factId = fact?.id ?? '';
  expect(await a.forgetFact(factId)).toBe(true);
});
