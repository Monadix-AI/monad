// mem0 backend end-to-end through the real daemon stack (HTTP → handlers → memory service → mem0
// adapter → client) over BOTH transports. Uses the `buildMem0` seam to inject a fake mem0 client, so
// no network/SDK is touched. Proves the control API routes to mem0 (not the built-in MD store) when
// cfg.memory.backend = 'mem0'.

import type { Fact } from '@monad/protocol';
import type { ModelRouter } from '@/agent/index.ts';
import type { Mem0Client, Mem0Memory } from '@/services/memory/mem0.ts';
import type { createStore } from '@/store/db/index.ts';

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryService } from '@/services/memory/index.ts';
import { createHttpTransport } from '@/transports/http.ts';
import { buildHandlers, mockModel, serveTransport, TRANSPORTS } from '../helpers.ts';

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;
const router: ModelRouter = { stream: () => (async function* () {})(), complete: async () => ({ text: '' }) };

class FakeMem0 implements Mem0Client {
  mem: Mem0Memory[] = [];
  userIds: string[] = [];
  async add(messages: { role: string; content: string }[], opts: { userId?: string; infer?: boolean }) {
    const m = { id: `m${this.mem.length}`, memory: messages.map((x) => x.content).join(' ') };
    if (opts.userId) this.userIds.push(opts.userId);
    if (opts.infer === false) this.mem.push(m); // the control-API addFact path (exact text)
    return { results: [m] };
  }
  async search() {
    return { results: this.mem };
  }
  async getAll() {
    return { results: this.mem };
  }
  async delete(id: string): Promise<{ message: string }> {
    this.mem = this.mem.filter((m) => m.id !== id);
    return { message: 'ok' };
  }
}

function mem0Service(fake: Mem0Client) {
  return (store: ReturnType<typeof createStore>) =>
    createMemoryService({
      store,
      root: mkdtempSync(join(tmpdir(), 'mem0-e2e-')),
      dbRoot: mkdtempSync(join(tmpdir(), 'mem0-e2e-')),
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
}

for (const kind of TRANSPORTS) {
  describe(`mem0 daemon e2e over ${kind}`, () => {
    test('status + facts add/list/forget route to the mem0 client; core is empty', async () => {
      const fake = new FakeMem0();
      const t = serveTransport(
        kind,
        createHttpTransport(buildHandlers(mockModel(), undefined, { memoryService: mem0Service(fake) }))
      );
      try {
        // status advertises mem0 + its resolved models
        const status = (await (await t.fetch('/v1/memory/status')).json()) as {
          backend: string;
          mem0: { ready: boolean; llm: string | null };
        };
        expect(status.backend).toBe('mem0');
        expect(status.mem0.ready).toBe(true);
        expect(status.mem0.llm).toBe('gpt');

        // add → lands in mem0 under the agent's userId (per-agent isolation), not an MD file
        const add = await t.fetch('/v1/memory/facts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scopeKind: 'agent', scopeId: 'agt_1', content: 'User uses Bun' })
        });
        expect(add.status).toBe(200);
        expect(((await add.json()) as { fact: Fact }).fact.content).toBe('User uses Bun');
        expect(fake.mem.map((m) => m.memory)).toEqual(['User uses Bun']);
        expect(fake.userIds).toContain('agent:agt_1');

        // list reads back through mem0
        const list = (await (await t.fetch('/v1/memory/facts?scopeKind=agent&scopeId=agt_1')).json()) as {
          facts: Fact[];
        };
        expect(list.facts.map((f) => f.content)).toEqual(['User uses Bun']);

        // mem0 has no editable markdown file → core is empty
        const core = (await (await t.fetch('/v1/memory/core?scopeKind=agent&scopeId=agt_1')).json()) as {
          core: string;
        };
        expect(core.core).toBe('');

        // forget routes to mem0.delete
        const forget = await t.fetch('/v1/memory/facts/m0', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scopeKind: 'agent', scopeId: 'agt_1' })
        });
        expect(forget.status).toBe(200);
        expect(fake.mem).toHaveLength(0);
      } finally {
        await t.stop();
      }
    });
  });
}
