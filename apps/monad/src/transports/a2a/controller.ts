import type { Agent } from '@monad/protocol';
import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';

import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { Elysia } from 'elysia';

import { buildAgentCard } from './agent-card.ts';
import { createA2aExecutor } from './executor.ts';
import { baseUrlOf } from './util.ts';

type Handlers = ReturnType<typeof createDaemonHandlers>;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params: unknown;
}

function rpcError(id: JsonRpcRequest['id'], code: number, message: string): Response {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } });
}

function sseFrame(id: JsonRpcRequest['id'], result: unknown): string {
  return `data: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`;
}

/** Exposes each A2A-enabled agent as a standard A2A server: an AgentCard at the well-known path and
 *  a JSON-RPC endpoint carrying `message/send`, `message/stream` (SSE), `tasks/get`, `tasks/cancel`.
 *  Mounted at the daemon root (paths are absolute `/a2a/...`), outside the `/v1` management group.
 *  A `DefaultRequestHandler` (with its own task store) is cached per agent so tasks persist across
 *  requests; disabled or unknown agents 404. */
export function createA2aController(handlers: Handlers) {
  const registry = new Map<string, DefaultRequestHandler>();

  async function enabledAgent(agentId: string): Promise<Agent | null> {
    try {
      const { agent } = await handlers.agent.getAgent({ agentId: agentId as Agent['id'] });
      return agent.a2a?.enabled ? agent : null;
    } catch {
      return null;
    }
  }

  function handlerFor(agent: Agent, baseUrl: string): DefaultRequestHandler {
    let handler = registry.get(agent.id);
    if (!handler) {
      handler = new DefaultRequestHandler(
        buildAgentCard(agent, baseUrl),
        new InMemoryTaskStore(),
        createA2aExecutor(agent.id, handlers)
      );
      registry.set(agent.id, handler);
    }
    return handler;
  }

  async function dispatch(handler: DefaultRequestHandler, rpc: JsonRpcRequest): Promise<Response> {
    switch (rpc.method) {
      case 'message/send':
        // biome-ignore lint/suspicious/noExplicitAny: params are validated inside the SDK handler.
        return Response.json({ jsonrpc: '2.0', id: rpc.id, result: await handler.sendMessage(rpc.params as any) });
      case 'tasks/get':
        // biome-ignore lint/suspicious/noExplicitAny: params are validated inside the SDK handler.
        return Response.json({ jsonrpc: '2.0', id: rpc.id, result: await handler.getTask(rpc.params as any) });
      case 'tasks/cancel':
        // biome-ignore lint/suspicious/noExplicitAny: params are validated inside the SDK handler.
        return Response.json({ jsonrpc: '2.0', id: rpc.id, result: await handler.cancelTask(rpc.params as any) });
      case 'message/stream': {
        // biome-ignore lint/suspicious/noExplicitAny: params are validated inside the SDK handler.
        const events = handler.sendMessageStream(rpc.params as any);
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const encoder = new TextEncoder();
            try {
              for await (const event of events) controller.enqueue(encoder.encode(sseFrame(rpc.id, event)));
            } catch (err) {
              const message = err instanceof Error ? err.message : 'stream error';
              controller.enqueue(encoder.encode(sseFrame(rpc.id, { kind: 'error', message })));
            } finally {
              controller.close();
            }
          }
        });
        return new Response(stream, {
          headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }
        });
      }
      default:
        return rpcError(rpc.id, -32601, `method not found: ${rpc.method}`);
    }
  }

  return new Elysia()
    .get(
      '/a2a/agents/:agentId/.well-known/agent-card.json',
      async ({ params, request, status }) => {
        const agent = await enabledAgent(params.agentId);
        if (!agent) return status(404, { error: 'a2a not enabled for this agent' });
        return buildAgentCard(agent, baseUrlOf(request));
      },
      { detail: { tags: ['http-only'], summary: 'A2A AgentCard', description: 'A2A AgentCard for one agent.' } }
    )
    .post(
      '/a2a/agents/:agentId',
      async ({ params, request, body, status }) => {
        const agent = await enabledAgent(params.agentId);
        if (!agent) return status(404, { error: 'a2a not enabled for this agent' });
        const rpc = body as JsonRpcRequest | null;
        if (rpc?.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
          return rpcError(rpc?.id ?? null, -32600, 'invalid JSON-RPC request');
        }
        return dispatch(handlerFor(agent, baseUrlOf(request)), rpc);
      },
      { detail: { tags: ['http-only'], summary: 'A2A JSON-RPC', description: 'A2A JSON-RPC endpoint for one agent.' } }
    );
}
