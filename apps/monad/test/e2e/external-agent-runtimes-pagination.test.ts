// e2e: GET /v1/external-agent-runtimes and GET /v1/external-agent-session-summaries paginate with
// cursorPaginationQuerySchema/cursorPaginationResponseSchema, over both transports.

import type { ListExternalAgentRuntimesResponse } from '@monad/protocol';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createStore } from '@/store/db/index.ts';
import { createHttpTransport } from '@/transports/http.ts';
import { buildHandlers, mockModel, serveTransport, TRANSPORTS, type TransportHandle } from '../helpers.ts';

function seedRunning(store: ReturnType<typeof createStore>, id: string, startedAt: string): void {
  store.upsertExternalAgentSession({
    id,
    transcriptTargetId: 'ses_01KWRUNTIME000000000001',
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
  describe(`external-agent runtime overview pagination over ${kind}`, () => {
    let t: TransportHandle;
    let store: ReturnType<typeof createStore>;

    beforeEach(() => {
      store = createStore();
      // Seed AFTER the transport/host exists: ExternalAgentHost reconciles orphaned "running"/"starting"
      // rows (no live process backing them) to 'stopped' once at construction, which would otherwise
      // race with (and erase) these fixture rows.
      t = serveTransport(kind, createHttpTransport(buildHandlers(mockModel(), undefined, { store })));
      for (let i = 0; i < 3; i++) seedRunning(store, `exa_rt_${i}`, `2026-07-06T00:00:0${i}.000Z`);
    });

    afterEach(async () => {
      await t.stop();
      store.close();
    });

    test('GET /v1/external-agent-runtimes returns a page + nextCursor', async () => {
      const res = await t.fetch('/v1/external-agent-runtimes?limit=2');
      expect(res.status).toBe(200);
      const body = (await res.json()) as ListExternalAgentRuntimesResponse;
      expect(body.sessions.map((s) => s.id)).toEqual(['exa_rt_1', 'exa_rt_2']);
      expect(body.nextCursor).toBeDefined();

      const nextRes = await t.fetch(`/v1/external-agent-runtimes?limit=2&before=${body.nextCursor}`);
      const nextBody = (await nextRes.json()) as ListExternalAgentRuntimesResponse;
      expect(nextBody.sessions.map((s) => s.id)).toEqual(['exa_rt_0']);
      expect(nextBody.nextCursor).toBeUndefined();
    });

    test('GET /v1/external-agent-session-summaries returns a page + nextCursor', async () => {
      const res = await t.fetch('/v1/external-agent-session-summaries?limit=1');
      expect(res.status).toBe(200);
      const body = (await res.json()) as ListExternalAgentRuntimesResponse;
      expect(body.sessions.length).toBe(1);
      expect(body.nextCursor).toBeDefined();
    });
  });
}
