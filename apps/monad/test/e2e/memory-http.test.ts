// L1 memory control API over both transports (docs/runtime.md): add/list/edit/forget facts +
// read/overwrite a scope's MEMORY.md. Backed by the built-in MD adapter (stub service in tests).

import type { Fact } from '@monad/protocol';

import { describe, expect, test } from 'bun:test';

import { createHttpTransport } from '@/transports/http.ts';
import { buildHandlers, mockModel, serveTransport, TRANSPORTS } from '../helpers.ts';

for (const kind of TRANSPORTS) {
  describe(`memory control API over ${kind}`, () => {
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
          body: JSON.stringify({ scopeKind: 'agent', scopeId: 'agt_X', core: '# Memory\n\n- hand-written\n' })
        });
        expect(put.status).toBe(200);
        const get = await t.fetch('/v1/memory/core?scopeKind=agent&scopeId=agt_X');
        const body = (await get.json()) as { core: string };
        expect(body.core).toContain('hand-written');
      } finally {
        await t.stop();
      }
    });
  });
}
