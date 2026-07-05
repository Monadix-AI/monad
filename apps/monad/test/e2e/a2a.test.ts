// e2e: the A2A (Agent2Agent) server surface over a real temp ~/.monad, exercised over BOTH transports
// (TCP loopback + Unix socket). An A2A-enabled agent serves an AgentCard + JSON-RPC message/send and
// message/stream backed by the mock model; a disabled agent 404s. The /v1/agents/:id/a2a status
// endpoint reports enablement + URLs.

import type { MonadPaths } from '@monad/home';
import type { Agent } from '@monad/protocol';

import { describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initMonadHome, loadAuth, loadConfig } from '@monad/home';

import { ModelService } from '@/handlers/settings/model/index.ts';
import { MOCK_REPLY } from '@/infra/mock-model.ts';
import { createHttpTransport } from '@/transports/http.ts';
import {
  buildHandlers,
  makeTestPaths,
  mockModel,
  seededProviderRegistry,
  serveTransport,
  TRANSPORTS,
  type TransportHandle
} from '../helpers.ts';

async function setup(): Promise<{ dir: string; app: ReturnType<typeof createHttpTransport> }> {
  const dir = join(tmpdir(), `monad-a2a-${process.pid}-${Date.now()}-${process.hrtime.bigint()}`);
  const paths: MonadPaths = makeTestPaths(dir);
  await initMonadHome(paths);
  const cfg = await loadConfig(paths.config);
  if (!cfg) throw new Error('config missing after init');
  const modelService = new ModelService(paths.auth, cfg, await loadAuth(paths.auth), seededProviderRegistry());
  const app = createHttpTransport(buildHandlers(mockModel(), { paths, modelService }));
  return { dir, app };
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body)
});

async function createAgent(t: TransportHandle, name: string, enabled: boolean): Promise<Agent> {
  const res = await t.fetch('/v1/agents', json('POST', { name, a2a: { enabled } }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { agent: Agent }).agent;
}

function sendParams(text: string): unknown {
  return {
    message: {
      kind: 'message',
      messageId: crypto.randomUUID(),
      role: 'user',
      parts: [{ kind: 'text', text }]
    }
  };
}

for (const kind of TRANSPORTS) {
  describe(`A2A over ${kind}`, () => {
    test('enabled agent serves AgentCard, status, message/send, message/stream', async () => {
      const { dir, app } = await setup();
      const t = serveTransport(kind, app);
      try {
        const agent = await createAgent(t, 'A2A Bot', true);

        // AgentCard at the well-known path.
        const cardRes = await t.fetch(`/a2a/agents/${agent.id}/.well-known/agent-card.json`);
        expect(cardRes.status).toBe(200);
        const card = (await cardRes.json()) as { name: string; url: string; capabilities: { streaming?: boolean } };
        expect(card.name).toBe('A2A Bot');
        expect(card.url).toContain(`/a2a/agents/${agent.id}`);
        expect(card.capabilities.streaming).toBe(true);

        // Management status endpoint.
        const statusRes = await t.fetch(`/v1/agents/${agent.id}/a2a`);
        expect(statusRes.status).toBe(200);
        const { status } = (await statusRes.json()) as {
          status: { enabled: boolean; agentCardUrl: string; jsonRpcUrl: string };
        };
        expect(status.enabled).toBe(true);
        expect(status.jsonRpcUrl).toContain(`/a2a/agents/${agent.id}`);
        expect(status.agentCardUrl).toContain('.well-known/agent-card.json');

        // message/send runs the agent loop and returns the mock reply.
        const sendRes = await t.fetch(
          `/a2a/agents/${agent.id}`,
          json('POST', { jsonrpc: '2.0', id: 1, method: 'message/send', params: sendParams('hi') })
        );
        expect(sendRes.status).toBe(200);
        const sendBody = (await sendRes.json()) as { result?: unknown; error?: unknown };
        expect(sendBody.error).toBeUndefined();
        expect(JSON.stringify(sendBody.result)).toContain(MOCK_REPLY);

        // message/stream yields an SSE stream ending in a final status-update carrying the reply.
        const streamRes = await t.fetch(
          `/a2a/agents/${agent.id}`,
          json('POST', { jsonrpc: '2.0', id: 2, method: 'message/stream', params: sendParams('hi again') })
        );
        expect(streamRes.status).toBe(200);
        expect(streamRes.headers.get('content-type')).toContain('text/event-stream');
        const streamText = await streamRes.text();
        expect(streamText).toContain('status-update');
        expect(streamText).toContain('"final":true');
        expect(streamText).toContain(MOCK_REPLY);
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('disabled agent 404s on card and JSON-RPC; status reports disabled', async () => {
      const { dir, app } = await setup();
      const t = serveTransport(kind, app);
      try {
        const agent = await createAgent(t, 'Off Bot', false);

        expect((await t.fetch(`/a2a/agents/${agent.id}/.well-known/agent-card.json`)).status).toBe(404);

        const rpcRes = await t.fetch(
          `/a2a/agents/${agent.id}`,
          json('POST', { jsonrpc: '2.0', id: 1, method: 'message/send', params: sendParams('hi') })
        );
        expect(rpcRes.status).toBe(404);

        const statusRes = await t.fetch(`/v1/agents/${agent.id}/a2a`);
        expect(statusRes.status).toBe(200);
        expect(((await statusRes.json()) as { status: { enabled: boolean } }).status.enabled).toBe(false);
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('unknown agent 404s on the A2A surface', async () => {
      const { dir, app } = await setup();
      const t = serveTransport(kind, app);
      try {
        expect((await t.fetch('/a2a/agents/agt_nope/.well-known/agent-card.json')).status).toBe(404);
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
}
