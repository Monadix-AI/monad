import type { MessageSendParams, TaskIdParams, TaskQueryParams } from '@a2a-js/sdk';
import type { Agent } from '@monad/protocol';
import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';

import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentIdSchema, jsonRpcRequestEnvelopeSchema } from '@monad/protocol';
import { Elysia } from 'elysia';

import { buildAgentCard } from './agent-card.ts';
import { createA2aExecutor } from './executor.ts';
import { messageSendParamsSchema, taskIdParamsSchema, taskQueryParamsSchema } from './schemas.ts';
import { baseUrlOf } from './util.ts';

type Handlers = ReturnType<typeof createDaemonHandlers>;

interface JsonRpcEnvelope {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params: unknown;
}

type A2aRpcRequest =
  | (JsonRpcEnvelope & { method: 'message/send' | 'message/stream'; params: MessageSendParams })
  | (JsonRpcEnvelope & { method: 'tasks/get'; params: TaskQueryParams })
  | (JsonRpcEnvelope & { method: 'tasks/cancel'; params: TaskIdParams });

type JsonRpcId = JsonRpcEnvelope['id'];
type ParsedRpcRequest =
  | { kind: 'supported'; request: A2aRpcRequest }
  | { kind: 'unsupported'; envelope: JsonRpcEnvelope }
  | { kind: 'invalid_params'; id: JsonRpcId }
  | { kind: 'invalid'; id: JsonRpcId };

function rpcError(id: JsonRpcId, code: number, message: string): Response {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } });
}

function sseFrame(id: JsonRpcId, result: unknown): string {
  return `data: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`;
}

function parseRpcRequest(body: unknown): ParsedRpcRequest {
  const parsedEnvelope = jsonRpcRequestEnvelopeSchema.safeParse(body);
  if (!parsedEnvelope.success) {
    return { kind: 'invalid', id: null };
  }
  const bodyEnvelope = parsedEnvelope.data;
  const envelope: JsonRpcEnvelope = {
    jsonrpc: '2.0',
    id: bodyEnvelope.id ?? null,
    method: bodyEnvelope.method,
    params: bodyEnvelope.params
  };
  switch (envelope.method) {
    case 'message/send':
    case 'message/stream': {
      const params = messageSendParamsSchema.safeParse(envelope.params);
      if (!params.success) return { kind: 'invalid_params', id: envelope.id };
      return {
        kind: 'supported',
        request: { ...envelope, method: envelope.method, params: params.data }
      };
    }
    case 'tasks/get': {
      const params = taskQueryParamsSchema.safeParse(envelope.params);
      if (!params.success) return { kind: 'invalid_params', id: envelope.id };
      return {
        kind: 'supported',
        request: { ...envelope, method: envelope.method, params: params.data }
      };
    }
    case 'tasks/cancel': {
      const params = taskIdParamsSchema.safeParse(envelope.params);
      if (!params.success) return { kind: 'invalid_params', id: envelope.id };
      return {
        kind: 'supported',
        request: { ...envelope, method: envelope.method, params: params.data }
      };
    }
    default:
      return { kind: 'unsupported', envelope };
  }
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
      const { agent } = await handlers.agent.getAgent({ agentId: agentIdSchema.parse(agentId) });
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

  async function dispatch(handler: DefaultRequestHandler, rpc: A2aRpcRequest): Promise<Response> {
    switch (rpc.method) {
      case 'message/send':
        return Response.json({ jsonrpc: '2.0', id: rpc.id, result: await handler.sendMessage(rpc.params) });
      case 'tasks/get':
        return Response.json({ jsonrpc: '2.0', id: rpc.id, result: await handler.getTask(rpc.params) });
      case 'tasks/cancel':
        return Response.json({ jsonrpc: '2.0', id: rpc.id, result: await handler.cancelTask(rpc.params) });
      case 'message/stream': {
        const events = handler.sendMessageStream(rpc.params);
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
        const parsed = parseRpcRequest(body);
        if (parsed.kind === 'invalid') {
          return rpcError(parsed.id, -32600, 'invalid JSON-RPC request');
        }
        if (parsed.kind === 'unsupported') {
          return rpcError(parsed.envelope.id, -32601, `method not found: ${parsed.envelope.method}`);
        }
        if (parsed.kind === 'invalid_params') {
          return rpcError(parsed.id, -32602, 'invalid params');
        }
        return dispatch(handlerFor(agent, baseUrlOf(request)), parsed.request);
      },
      { detail: { tags: ['http-only'], summary: 'A2A JSON-RPC', description: 'A2A JSON-RPC endpoint for one agent.' } }
    );
}
