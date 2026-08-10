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
import { newId, parseEventPayload } from '@monad/protocol';

import { AtomPackRegistry } from '#/handlers/atom-pack/atom-pack-registry.ts';
import { createHookRunner } from '#/hooks/runner.ts';
import { MOCK_REPLY } from '#/infra/mock-model.ts';
import { registerMemoryHooks } from '#/services/memory/hooks.ts';
import { createMemoryService } from '#/services/memory/index.ts';
import { createStore } from '#/store/db/index.ts';
import { createHttpTransport } from '#/transports/http.ts';
import { DAEMON_E2E_TIMEOUT_BUDGET } from '../../scripts/e2e-timeout-budget.ts';
import { buildHandlers, mockModel, serveTransport, stubMemoryService, stubModelDeps, TRANSPORTS } from '../helpers.ts';
import { waitFor } from '../wait.ts';

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
    registerMemoryHooks(registry, memoryService, {
      policyForSession: () => ({
        agentId: 'agt_100000000000',
        effectiveLevel: 3,
        enabled: true,
        advanced: true
      })
    });
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
        state: 'active',
        agentIds: ['agt_100000000000'],
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
        until: (e) => e.type === 'session.message.completed',
        timeoutMs: DAEMON_E2E_TIMEOUT_BUDGET.streamMs
      });
      const completed = events.find((e) => e.type === 'session.message.completed');
      if (!completed) throw new Error('missing completed message');
      expect(parseEventPayload('session.message.completed', completed.payload).message.text).toBe(MOCK_REPLY);

      // observe is fire-and-forget after AfterTurn — wait for the call itself rather than a tick.
      await waitFor(() => fake.addCalls.some((c) => c.infer !== false), {
        message: 'AfterTurn observe never reached mem0'
      });

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

test('disabled Agent skips recalled context, session notes, nudge, and observation', async () => {
  const store = createStore();
  const memoryService = stubMemoryService(store);
  let recalls = 0;
  let observations = 0;
  let notes = 0;
  memoryService.recallContext = async () => {
    recalls++;
    return 'recalled';
  };
  memoryService.observeTurn = () => {
    observations++;
  };
  const registry = new AtomPackRegistry();
  registerMemoryHooks(registry, memoryService, {
    extraContext: () => {
      notes++;
      return 'notes';
    },
    policyForSession: () => ({
      agentId: 'agt_100000000000',
      effectiveLevel: 0,
      enabled: false,
      advanced: true
    })
  });
  const hooks = createHookRunner({ config: {}, atomHooks: registry.hooks, cwd: tmpdir(), log });
  const input = {
    sessionId: 'ses_100000000000',
    cwd: tmpdir(),
    timestamp: new Date(0).toISOString()
  } as const;

  const before = await hooks.run({ ...input, event: 'BeforeTurn', prompt: 'Remember this' });
  await hooks.run({ ...input, event: 'AfterTurn', response: 'Done', ok: true, reason: 'completed' });

  expect({
    additionalContext: before.additionalContext,
    recalls,
    observations,
    notes
  }).toEqual({
    additionalContext: [],
    recalls: 0,
    observations: 0,
    notes: 0
  });
});
