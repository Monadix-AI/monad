// e2e: GET /v1/mesh/runtimes and GET /v1/mesh/session-summaries paginate with
// cursorPaginationQuerySchema/cursorPaginationResponseSchema, over both transports.

import type { ListMeshAgentRuntimesResponse } from '@monad/protocol';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createStore } from '#/store/db/index.ts';
import { createHttpTransport } from '#/transports/http.ts';
import { buildHandlers, mockModel, serveTransport, TRANSPORTS, type TransportHandle } from '../helpers.ts';

function seedRunning(store: ReturnType<typeof createStore>, id: string, startedAt: string): void {
  store.upsertMeshSession({
    id,
    transcriptTargetId: 'ses_01KWRUNT0GbJ',
    agentName: 'codex',
    provider: 'codex',
    workingPath: '/tmp/p',
    launchMode: 'app-server',
    runtimeRole: 'managed-project-agent',
    agentRuntimeId: id,
    agentRuntimeTokenHash: null,
    lastDeliveredSeq: 0,
    lastVisibleSeq: 0,
    state: 'running',
    pid: null,
    providerSessionRef: null,
    outputSnapshot: '',
    exitCode: null,
    startedAt,
    updatedAt: startedAt,
    exitedAt: null
  });
}

for (const kind of TRANSPORTS) {
  describe(`mesh-agent runtime overview pagination over ${kind}`, () => {
    let t: TransportHandle;
    let store: ReturnType<typeof createStore>;

    beforeEach(() => {
      store = createStore();
      // Seed AFTER the transport/host exists: MeshAgentHost reconciles orphaned "running"/"starting"
      // rows (no live process backing them) to 'stopped' once at construction, which would otherwise
      // race with (and erase) these fixture rows.
      t = serveTransport(kind, createHttpTransport(buildHandlers(mockModel(), undefined, { store })));
      for (let i = 0; i < 3; i++) seedRunning(store, `mesh_rt${i}000000000`, `2026-07-06T00:00:0${i}.000Z`);
    });

    afterEach(async () => {
      await t.stop();
      store.close();
    });

    test('GET /v1/mesh/runtimes returns a page + nextCursor', async () => {
      const res = await t.fetch('/v1/mesh/runtimes?limit=2');
      expect(res.status).toBe(200);
      const body = (await res.json()) as ListMeshAgentRuntimesResponse;
      expect(body.sessions.map((s) => s.id)).toEqual(['mesh_rt1000000000', 'mesh_rt2000000000']);

      const nextRes = await t.fetch(`/v1/mesh/runtimes?limit=2&before=${body.nextCursor}`);
      expect(nextRes.status).toBe(200);
      const nextBody = (await nextRes.json()) as ListMeshAgentRuntimesResponse;
      expect(nextBody.sessions.map((s) => s.id)).toEqual(['mesh_rt0000000000']);
      expect(nextBody.nextCursor).toBeUndefined();
    });

    test('GET /v1/mesh/session-summaries returns a page + nextCursor', async () => {
      const res = await t.fetch('/v1/mesh/session-summaries?limit=1');
      expect(res.status).toBe(200);
      const body = (await res.json()) as ListMeshAgentRuntimesResponse;
      expect(body.sessions.map((session) => session.id)).toEqual(['mesh_rt0000000000']);

      const nextRes = await t.fetch(`/v1/mesh/session-summaries?limit=1&before=${body.nextCursor}`);
      expect(nextRes.status).toBe(200);
      const nextBody = (await nextRes.json()) as ListMeshAgentRuntimesResponse;
      expect(nextBody.sessions.map((session) => session.id)).toEqual(['mesh_rt1000000000']);
    });
  });
}
