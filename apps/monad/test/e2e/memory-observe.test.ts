// e2e: a real turn through the daemon fires the memory lifecycle wiring (registerMemoryHooks) over
// BOTH transports — BeforeTurn recall (mem0.search) + AfterTurn observe (mem0.add of the exchange).
// Exercises the SAME wiring main.ts ships (registerMemoryHooks), not a copy, against the real agent
// loop + hook runner. mem0 backend (its observe is the per-turn write path; built-in has none).

import type { ModelRouter } from '#/agent/index.ts';
import type { Mem0Client, Mem0Memory } from '#/services/memory/mem0.ts';

import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@monad/logger';
import { newId } from '@monad/protocol';

import { AtomPackRegistry } from '#/handlers/atom-pack/atom-pack-registry.ts';
import { createHookRunner } from '#/hooks/runner.ts';
import { MOCK_REPLY } from '#/infra/mock-model.ts';
import { registerMemoryHooks } from '#/services/memory/hooks.ts';
import { createMemoryService } from '#/services/memory/index.ts';
import { createStore } from '#/store/db/index.ts';
import { createHttpTransport } from '#/transports/http.ts';
import { buildHandlers, mockModel, serveTransport, stubModelDeps, TRANSPORTS } from '../helpers.ts';

const log = createLogger('e2e-observe');
const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;
const router: ModelRouter = { stream: () => (async function* () {})(), complete: async () => ({ text: '' }) };

class FakeMem0 implements Mem0Client {
  addCalls: { userId?: string; content: string; infer?: boolean }[] = [];
  searchCalls = 0;
  mem: Mem0Memory[] = [];
  async add(messages: { role: string; content: string }[], opts: { userId?: string; infer?: boolean }) {
    this.addCalls.push({
      userId: opts.userId,
      content: messages.map((m) => m.content).join(' || '),
      infer: opts.infer
    });
    const m = { id: `m${this.mem.length}`, memory: messages.map((m) => m.content).join(' ') };
    if (opts.infer === false) this.mem.push(m);
    return { results: [m] };
  }
  async search() {
    this.searchCalls++;
    return { results: this.mem };
  }
  async getAll() {
    return { results: this.mem };
  }
  async delete(_id: string): Promise<{ message: string }> {
    return { message: 'ok' };
  }
}

for (const kind of TRANSPORTS) {
  test(`[${kind}] a real turn fires BeforeTurn recall + AfterTurn observe → mem0`, async () => {
    const store = createStore();
    const fake = new FakeMem0();
    const memoryService = createMemoryService({
      store,
      root: mkdtempSync(join(tmpdir(), 'observe-e2e-')),
      dbRoot: mkdtempSync(join(tmpdir(), 'observe-e2e-')),
      router,
      extractModel: () => 'test',
      backend: () => 'mem0',
      mem0Models: () => ({
        models: {
          llm: { provider: 'openai', model: 'gpt' },
          embedder: { provider: 'openai', model: 'emb' },
          dim: 1536
        },
        llm: 'gpt',
        embedder: 'emb',
        dim: 1536
      }),
      buildMem0: async () => fake,
      log: silent
    });
    // The real wiring main.ts ships — recall on BeforeTurn, observe on AfterTurn.
    const registry = new AtomPackRegistry();
    registerMemoryHooks(registry, memoryService);
    const hooks = createHookRunner({ config: {}, atomHooks: registry.hooks, cwd: tmpdir(), log });

    const app = createHttpTransport(
      buildHandlers(mockModel(), stubModelDeps(), {
        store,
        memoryService: () => memoryService,
        hooks,
        hookCwd: tmpdir()
      })
    );
    const tr = serveTransport(kind, app);
    try {
      // A session bound to an agent (observe attaches to agentIds[0]).
      const sid = newId('ses');
      store.insertSession({
        id: sid,
        title: 't',
        ownerPrincipalId: 'prn_100000000000',
        state: 'active',
        agentIds: ['agt_100000000000'],
        parentSessionId: null,
        archived: false,
        restoreCount: 0,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString()
      });

      await tr.fetch(`/v1/sessions/${sid}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'I deploy with Bun' })
      });
      const events = await tr.sse(`/v1/sessions/${sid}/events`, {
        until: (e) => e.type === 'agent.message',
        timeoutMs: 4000
      });
      expect(events.find((e) => e.type === 'agent.message')?.payload.text).toBe(MOCK_REPLY);

      // observe is fire-and-forget after AfterTurn — give it a tick to reach the client.
      await Bun.sleep(60);

      // BeforeTurn recall queried mem0.
      expect(fake.searchCalls).toBeGreaterThan(0);
      // AfterTurn observe forwarded the exchange to mem0 (infer=true extraction) under the agent userId.
      const observe = fake.addCalls.find((c) => c.infer !== false);
      expect(observe?.userId).toBe('agent:agt_100000000000');
      expect(observe?.content).toContain('I deploy with Bun');
      expect(observe?.content).toContain(MOCK_REPLY);
    } finally {
      await tr.stop();
    }
  });
}
