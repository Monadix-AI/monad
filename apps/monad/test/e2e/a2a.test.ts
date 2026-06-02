// e2e: the A2A (Agent2Agent) server surface over a real temp ~/.monad, exercised over BOTH transports
// (TCP loopback + Unix socket). An A2A-enabled agent serves an AgentCard + JSON-RPC SendMessage and
// SendStreamingMessage backed by the mock model; a disabled agent 404s. The /v1/agents/:id/a2a status
// endpoint reports enablement + URLs.

import type { MonadPaths } from '@monad/environment';
import type { Agent } from '@monad/protocol';

import { describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initMonadHome, loadAuth, loadConfig } from '@monad/environment';

import { ModelService } from '#/handlers/settings/model/index.ts';
import { MOCK_REPLY } from '#/infra/mock-model.ts';
import { createHttpTransport } from '#/transports/http.ts';
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
  const cfg = await loadConfig(paths);
  if (!cfg) throw new Error('config missing after init');
  const modelService = new ModelService(paths.auth, cfg, await loadAuth(paths.auth), seededProviderRegistry());
  const app = createHttpTransport(buildHandlers(mockModel(), { paths, modelService }));
  return { dir, app };
}

const json = (method: string, body?: unknown, a2aVersion?: string): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', ...(a2aVersion ? { 'A2A-Version': a2aVersion } : {}) },
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
      messageId: crypto.randomUUID(),
      role: 'ROLE_USER',
      parts: [{ text }]
    }
  };
}

function rpc(method: string, id: number, params: unknown, version = '1.0'): RequestInit {
  return json('POST', { jsonrpc: '2.0', id, method, params }, version);
}

type JsonRpcEnvelope = {
  jsonrpc: '2.0';
  id: number;
  result: {
    task?: {
      id: string;
      status: {
        state: string;
        message?: { parts: Array<{ text?: string; mediaType?: string }> };
      };
    };
    statusUpdate?: {
      status: {
        state: string;
        message?: { parts: Array<{ text?: string; mediaType?: string }> };
      };
    };
  };
};

for (const kind of TRANSPORTS) {
  describe(`A2A over ${kind}`, () => {
    test('enabled agent serves a v1 AgentCard and executes SendMessage and SendStreamingMessage', async () => {
      const { dir, app } = await setup();
      const t = serveTransport(kind, app);
      try {
        const agent = await createAgent(t, 'A2A Bot', true);

        const cardRes = await t.fetch(`/a2a/agents/${agent.id}/.well-known/agent-card.json`);
        expect(cardRes.status).toBe(200);
        expect(await cardRes.json()).toEqual({
          name: 'A2A Bot',
          description: 'Monad agent A2A Bot',
          supportedInterfaces: [
            {
              url: expect.stringContaining(`/a2a/agents/${agent.id}`),
              protocolBinding: 'JSONRPC',
              protocolVersion: '1.0',
              tenant: ''
            }
          ],
          version: '1.0.0',
          capabilities: {
            streaming: true,
            pushNotifications: false,
            extensions: [],
            extendedAgentCard: false
          },
          securitySchemes: {},
          securityRequirements: [],
          defaultInputModes: ['text/plain'],
          defaultOutputModes: ['text/plain'],
          skills: [
            {
              id: 'chat',
              name: 'Chat',
              description: 'Send a message and receive the agent’s reply.',
              tags: ['chat', 'text'],
              examples: [],
              inputModes: ['text/plain'],
              outputModes: ['text/plain'],
              securityRequirements: []
            }
          ],
          signatures: []
        });

        const statusRes = await t.fetch(`/v1/agents/${agent.id}/a2a`);
        expect(statusRes.status).toBe(200);
        const { status } = (await statusRes.json()) as {
          status: { enabled: boolean; agentCardUrl: string; jsonRpcUrl: string };
        };
        expect(status.enabled).toBe(true);
        expect(status.jsonRpcUrl).toContain(`/a2a/agents/${agent.id}`);
        expect(status.agentCardUrl).toContain('.well-known/agent-card.json');

        const sendRes = await t.fetch(`/a2a/agents/${agent.id}`, rpc('SendMessage', 1, sendParams('hi')));
        expect(sendRes.status).toBe(200);
        const sendBody = (await sendRes.json()) as JsonRpcEnvelope;
        expect(sendBody.jsonrpc).toBe('2.0');
        expect(sendBody.id).toBe(1);
        expect(sendBody.result.task?.status.state).toBe('TASK_STATE_COMPLETED');
        expect(sendBody.result.task?.status.message?.parts).toEqual([{ text: MOCK_REPLY, mediaType: 'text/plain' }]);
        const taskId = sendBody.result.task?.id;
        if (!taskId) throw new Error('SendMessage did not return a task id');

        const listRes = await t.fetch(
          `/a2a/agents/${agent.id}`,
          rpc('ListTasks', 3, { status: 'TASK_STATE_COMPLETED' })
        );
        expect(listRes.status).toBe(200);
        const listBody = (await listRes.json()) as {
          jsonrpc: '2.0';
          id: number;
          result?: { tasks: Array<{ id: string; status: { state: string } }>; pageSize: number; totalSize: number };
          error?: unknown;
        };
        expect(listBody.jsonrpc).toBe('2.0');
        expect(listBody.id).toBe(3);
        if (!listBody.result) throw new Error(`ListTasks failed: ${JSON.stringify(listBody.error)}`);
        if (!Array.isArray(listBody.result.tasks)) {
          throw new Error(`ListTasks returned no tasks: ${JSON.stringify(listBody.result)}`);
        }
        expect(listBody.result.tasks.map((task) => ({ id: task.id, state: task.status.state }))).toEqual([
          { id: taskId, state: 'TASK_STATE_COMPLETED' }
        ]);
        expect({ pageSize: listBody.result.pageSize, totalSize: listBody.result.totalSize }).toEqual({
          pageSize: 50,
          totalSize: 1
        });

        const streamRes = await t.fetch(
          `/a2a/agents/${agent.id}`,
          rpc('SendStreamingMessage', 2, sendParams('hi again'))
        );
        expect(streamRes.status).toBe(200);
        expect(streamRes.headers.get('content-type')).toContain('text/event-stream');
        const streamEvents = (await streamRes.text())
          .split('\n\n')
          .filter((frame) => frame.startsWith('data: '))
          .map((frame) => JSON.parse(frame.slice(6)) as JsonRpcEnvelope);
        const finalEvent = streamEvents.at(-1);
        expect(finalEvent?.jsonrpc).toBe('2.0');
        expect(finalEvent?.id).toBe(2);
        expect(finalEvent?.result.statusUpdate?.status.state).toBe('TASK_STATE_COMPLETED');
        expect(finalEvent?.result.statusUpdate?.status.message?.parts).toEqual([
          { text: MOCK_REPLY, mediaType: 'text/plain' }
        ]);
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

        const rpcRes = await t.fetch(`/a2a/agents/${agent.id}`, rpc('SendMessage', 1, sendParams('hi')));
        expect(rpcRes.status).toBe(404);

        const statusRes = await t.fetch(`/v1/agents/${agent.id}/a2a`);
        expect(statusRes.status).toBe(200);
        expect(((await statusRes.json()) as { status: { enabled: boolean } }).status.enabled).toBe(false);
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('invalid method params are rejected at the A2A JSON-RPC boundary', async () => {
      const { dir, app } = await setup();
      const t = serveTransport(kind, app);
      try {
        const agent = await createAgent(t, 'Validation Bot', true);
        const res = await t.fetch(`/a2a/agents/${agent.id}`, rpc('SendMessage', 9, {}));

        expect(await res.json()).toEqual({
          jsonrpc: '2.0',
          id: 9,
          error: {
            code: -32602,
            message: 'message.messageId is required.',
            data: [
              {
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                reason: 'INVALID_PARAMS',
                domain: 'a2a-protocol.org'
              }
            ]
          }
        });
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

    test('strict v1 rejects a missing version header and the removed v0.3 method name', async () => {
      const { dir, app } = await setup();
      const t = serveTransport(kind, app);
      try {
        const agent = await createAgent(t, 'Strict Bot', true);
        const path = `/a2a/agents/${agent.id}`;

        const missingVersion = await t.fetch(
          path,
          json('POST', { jsonrpc: '2.0', id: 10, method: 'SendMessage', params: sendParams('hi') })
        );
        expect(await missingVersion.json()).toEqual({
          jsonrpc: '2.0',
          id: 10,
          error: {
            code: -32009,
            message: "The requested A2A protocol version '0.3' is not supported. Supported versions: 1.0",
            data: [
              {
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                reason: 'VERSION_NOT_SUPPORTED',
                domain: 'a2a-protocol.org'
              }
            ]
          }
        });

        const legacyMethod = await t.fetch(path, rpc('message/send', 11, sendParams('hi')));
        expect(await legacyMethod.json()).toEqual({
          jsonrpc: '2.0',
          id: 11,
          error: { code: -32601, message: 'Invalid method.' }
        });
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
}
