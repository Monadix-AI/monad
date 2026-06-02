import type { Agent } from '@monad/protocol';
import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';

import {
  A2A_VERSION_HEADER,
  Extensions,
  formatSSEErrorEvent,
  formatSSEEvent,
  HTTP_EXTENSION_HEADER,
  SSE_HEADERS
} from '@a2a-js/sdk';
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
  validateVersion
} from '@a2a-js/sdk/server';
import { agentIdSchema } from '@monad/protocol';
import { Elysia } from 'elysia';

import { buildAgentCard } from './agent-card.ts';
import { createA2aExecutor } from './executor.ts';
import { baseUrlOf } from './util.ts';

type Handlers = ReturnType<typeof createDaemonHandlers>;
type JsonRpcResult = Awaited<ReturnType<JsonRpcTransportHandler['handle']>>;
type JsonRpcStream = Extract<JsonRpcResult, AsyncGenerator<unknown, void, undefined>>;
type JsonRpcId = string | number | null;

interface AgentHandler {
  request: DefaultRequestHandler;
  transport: JsonRpcTransportHandler;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function transportBody(body: unknown): string | Record<string, unknown> {
  if (typeof body === 'string' || isRecord(body)) return body;
  return '';
}

function requestId(body: unknown): JsonRpcId {
  if (!isRecord(body)) return null;
  const id = body.id;
  return typeof id === 'string' || typeof id === 'number' || id === null ? id : null;
}

function isJsonRpcStream(result: JsonRpcResult): result is JsonRpcStream {
  return Symbol.asyncIterator in result;
}

function jsonRpcError(body: unknown, error: unknown): Response {
  return Response.json({
    jsonrpc: '2.0',
    id: requestId(body),
    error: JsonRpcTransportHandler.mapToJSONRPCError(error)
  });
}

async function streamResponse(stream: JsonRpcStream, id: JsonRpcId): Promise<Response> {
  let first: IteratorResult<unknown, void>;
  try {
    first = await stream.next();
  } catch (error) {
    return jsonRpcError({ id }, error);
  }

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        if (!first.done) controller.enqueue(encoder.encode(formatSSEEvent(first.value)));
        for await (const event of stream) controller.enqueue(encoder.encode(formatSSEEvent(event)));
      } catch (error) {
        const envelope = {
          jsonrpc: '2.0',
          id,
          error: JsonRpcTransportHandler.mapToJSONRPCError(error)
        };
        controller.enqueue(encoder.encode(formatSSEErrorEvent(envelope)));
      } finally {
        controller.close();
      }
    }
  });
  return new Response(body, { headers: SSE_HEADERS });
}

/** Exposes each A2A-enabled agent as a strict A2A v1.0 JSON-RPC server. The AgentCard advertises
 *  only the v1 JSONRPC binding; requests without `A2A-Version: 1.0` and v0.3 method names fail. */
export function createA2aController(handlers: Handlers) {
  const registry = new Map<string, AgentHandler>();

  async function enabledAgent(agentId: string): Promise<Agent | null> {
    try {
      const { agent } = await handlers.agent.getAgent({ agentId: agentIdSchema.parse(agentId) });
      return agent.a2a?.enabled ? agent : null;
    } catch {
      return null;
    }
  }

  function handlerFor(agent: Agent, baseUrl: string): AgentHandler {
    let handler = registry.get(agent.id);
    if (!handler) {
      const request = new DefaultRequestHandler(
        buildAgentCard(agent, baseUrl),
        new InMemoryTaskStore(),
        createA2aExecutor(agent.id, handlers)
      );
      handler = { request, transport: new JsonRpcTransportHandler(request) };
      registry.set(agent.id, handler);
    }
    return handler;
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

        const handler = handlerFor(agent, baseUrlOf(request));
        const context = new ServerCallContext({
          requestedVersion: request.headers.get(A2A_VERSION_HEADER) ?? undefined,
          requestedExtensions: Extensions.parseServiceParameter(request.headers.get(HTTP_EXTENSION_HEADER) ?? undefined)
        });

        try {
          validateVersion(context.requestedVersion, await handler.request.getAgentCard(), 'JSONRPC');
          const result = await handler.transport.handle(transportBody(body), context);
          return isJsonRpcStream(result) ? streamResponse(result, requestId(body)) : Response.json(result);
        } catch (error) {
          return jsonRpcError(body, error);
        }
      },
      { detail: { tags: ['http-only'], summary: 'A2A JSON-RPC', description: 'A2A JSON-RPC endpoint for one agent.' } }
    );
}
