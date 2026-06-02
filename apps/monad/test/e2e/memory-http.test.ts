// L1 memory control API over both transports (docs/internals/infra/runtime.md): add/list/edit/forget facts +
// read/overwrite a scope's MEMORY.md. Backed by the built-in MD adapter (stub service in tests).

import type { Fact } from '@monad/protocol';

import { describe, expect, test } from 'bun:test';

import { createHttpTransport } from '#/transports/http.ts';
import { buildHandlers, mockModel, serveTransport, TRANSPORTS } from '../helpers.ts';

for (const kind of TRANSPORTS) {
  describe(`memory control API over ${kind}`, () => {
    test('preparing mem0 dependencies does not activate the backend', async () => {
      const prepared: string[] = [];
      const activated: string[] = [];
      const handlers = buildHandlers(mockModel(), undefined, {
        memoryPrepareBackend: async (backend) => {
          prepared.push(backend);
        },
        memorySetBackend: async (backend) => {
          activated.push(backend);
        }
      });
      const t = serveTransport(kind, createHttpTransport(handlers));
      try {
        const res = await t.fetch('/v1/memory/backend/prepare', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ backend: 'mem0' })
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        expect(prepared).toEqual(['mem0']);
        expect(activated).toEqual([]);
      } finally {
        await t.stop();
      }
    });

    test('add → list → edit → forget round-trips per scope', async () => {
      const t = serveTransport(kind, createHttpTransport(buildHandlers(mockModel())));
      try {
        const add = await t.fetch('/v1/memory/facts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scopeKind: 'global', scopeId: '*', content: 'User deploys with Bun, not Node' })
        });
        expect(add.status).toBe(200);
        const { fact } = (await add.json()) as { fact: Fact };
        expect(fact.content).toBe('User deploys with Bun, not Node');
        expect(fact.provClass).toBe('user');

        const list = await t.fetch('/v1/memory/facts?scopeKind=global&scopeId=*');
        const { facts } = (await list.json()) as { facts: Fact[] };
        expect(facts.map((f) => f.content)).toEqual(['User deploys with Bun, not Node']);

        const edit = await t.fetch(`/v1/memory/facts/${fact.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scopeKind: 'global', scopeId: '*', content: 'User deploys with Bun' })
        });
        expect(edit.status).toBe(200);
        const edited = (await edit.json()) as { fact: Fact };

        const forget = await t.fetch(`/v1/memory/facts/${edited.fact.id}`, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scopeKind: 'global', scopeId: '*' })
        });
        expect(forget.status).toBe(200);

        const after = await t.fetch('/v1/memory/facts?scopeKind=global&scopeId=*');
        expect(((await after.json()) as { facts: Fact[] }).facts).toEqual([]);
      } finally {
        await t.stop();
      }
    });

    test('a secret-only fact is rejected (400) before it ever hits disk', async () => {
      const t = serveTransport(kind, createHttpTransport(buildHandlers(mockModel())));
      try {
        const res = await t.fetch('/v1/memory/facts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scopeKind: 'global', scopeId: '*', content: 'sk-abcdefghijklmnopqrstuvwxyz123456' })
        });
        expect(res.status).toBe(400);
      } finally {
        await t.stop();
      }
    });

    test('getCore/putCore expose the raw MEMORY.md for a scope', async () => {
      const t = serveTransport(kind, createHttpTransport(buildHandlers(mockModel())));
      try {
        const put = await t.fetch('/v1/memory/core', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            scopeKind: 'agent',
            scopeId: 'agt_X00000000000',
            core: '# Memory\n\n- hand-written\n'
          })
        });
        expect(put.status).toBe(200);
        const get = await t.fetch('/v1/memory/core?scopeKind=agent&scopeId=agt_X00000000000');
        const body = (await get.json()) as { core: string };
        expect(body.core).toContain('hand-written');
      } finally {
        await t.stop();
      }
    });

    test('L3 law reads forward an Agent scope and exclude other Agents', async () => {
      const getLaws = async (query?: { scopeKind?: string; scopeId?: string }) => {
        const scope = query?.scopeKind && query.scopeId ? `${query.scopeKind}:${query.scopeId}` : undefined;
        const laws = [
          {
            id: 'law-a',
            scope: 'agent:agt_A00000000000',
            statement: 'Agent A rule',
            confidence: 0.9,
            effectiveConfidence: 0.8,
            stale: false,
            contradictedBy: null,
            grounding: { facts: [], edges: [] },
            updatedAt: 1
          },
          {
            id: 'law-b',
            scope: 'agent:agt_B00000000000',
            statement: 'Agent B rule',
            confidence: 0.9,
            effectiveConfidence: 0.8,
            stale: false,
            contradictedBy: null,
            grounding: { facts: [], edges: [] },
            updatedAt: 1
          }
        ];
        return { laws: scope ? laws.filter((law) => law.scope === scope) : laws };
      };
      const t = serveTransport(kind, createHttpTransport(buildHandlers(mockModel(), undefined, { getLaws })));
      try {
        const res = await t.fetch('/v1/memory/laws?scopeKind=agent&scopeId=agt_A00000000000');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          laws: [expect.objectContaining({ id: 'law-a', scope: 'agent:agt_A00000000000' })]
        });
      } finally {
        await t.stop();
      }
    });
  });
}
