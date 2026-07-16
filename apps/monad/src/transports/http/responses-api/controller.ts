import type { AgentId, SessionId } from '@monad/protocol';
import type { ResponseOutputMessage, ResponseOutputText, ResponseUsage } from 'openai/resources/responses/responses';
import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';
import type { OpenAiCompatConfig } from '#/transports/http/openai-compat.ts';
import type { ResponseObject, ResponsesRequest, StoredResponse } from './types.ts';

import { newId, parseEventPayload } from '@monad/protocol';
import { Elysia } from 'elysia';

import { handleFunctionToolPath } from './function-tools.ts';
import { buildAmbientContext, buildUsage, computeOutputText, extractFunctionTools, extractInputText } from './input.ts';
import {
  checkToken,
  errorResponse,
  handlerErrorToResponse,
  jsonResponse,
  MAX_STORED_RESPONSES,
  RESPONSE_GC_INTERVAL_MS,
  RESPONSE_TTL_MS,
  SESSION_ORIGIN
} from './shared.ts';
import { buildStreamingResponse } from './streaming.ts';

// ── controller factory ────────────────────────────────────────────────────────

export function createResponsesApiController(
  handlers: ReturnType<typeof createDaemonHandlers>,
  encoder: TextEncoder,
  getConfig: () => Promise<OpenAiCompatConfig>
  // biome-ignore lint/suspicious/noExplicitAny: Elysia's route generic conflicts with plugin signature; cast is safe at runtime
): Elysia<any, any, any, any, any, any, any> {
  const storedResponses = new Map<string, StoredResponse>();

  const gcTimer = setInterval(() => {
    const cutoff = Date.now() - RESPONSE_TTL_MS;
    for (const [id, entry] of storedResponses) {
      if (entry.lastUsed < cutoff) storedResponses.delete(id);
    }
  }, RESPONSE_GC_INTERVAL_MS);
  gcTimer.unref();

  async function guard(request: Request): Promise<Response | null> {
    const config = await getConfig();
    if (!config.enabled) {
      return errorResponse(
        'OpenAI-compat API is disabled. Set openaiCompat.enabled=true in config.json.',
        404,
        'api_error',
        'disabled'
      );
    }
    if (!config.token) {
      return errorResponse(
        'OpenAI-compatible Responses API requires a token. Set openaiCompat.token in config.json.',
        401,
        'api_error',
        'unauthorized'
      );
    }
    if (!checkToken(request, config.token)) {
      return errorResponse('Invalid or missing Bearer token.', 401, 'api_error', 'unauthorized');
    }
    return null;
  }

  return (
    new Elysia({ tags: ['http-only'] })
      // ── create response ───────────────────────────────────────────────────────
      .post('/v1/responses', async ({ request }) => {
        const block = await guard(request);
        if (block) return block;

        let body: ResponsesRequest;
        try {
          body = (await request.json()) as ResponsesRequest;
        } catch {
          return errorResponse('Invalid JSON in request body');
        }

        if (!body.model || typeof body.model !== 'string') return errorResponse('model is required');
        if (body.input == null) return errorResponse('input is required');

        // Validate previous_response_id before any I/O so we fail fast with a 404.
        const sessionIdOverride = request.headers.get('x-monad-session-id') as SessionId | null;
        if (!sessionIdOverride && body.previous_response_id) {
          if (!storedResponses.has(body.previous_response_id)) {
            return errorResponse(
              `Response not found: ${body.previous_response_id}`,
              404,
              'invalid_request_error',
              'response_not_found'
            );
          }
        }

        // Resolve agent: header override > model id/name > default. Only visibility.public agents
        // are addressable — private agents must not be reachable here even by agt_ ID, matching
        // the gate the chat completions path enforces. No fall-back-to-all.
        const agentOverride = request.headers.get('x-monad-agent-id');
        const requestedAgent = agentOverride ?? (body.model !== 'default' ? body.model : undefined);
        let agentId: AgentId | undefined;

        if (requestedAgent) {
          let agents: Awaited<ReturnType<typeof handlers.agent.listAgents>>['agents'];
          try {
            ({ agents } = await handlers.agent.listAgents());
          } catch (err) {
            return handlerErrorToResponse(err);
          }
          const selectable = agents.filter((a) => a.visibility?.public);
          const match = selectable.find((a) => a.id === requestedAgent || a.name === requestedAgent);
          if (!match) {
            return errorResponse(`Model not found: ${requestedAgent}`, 404, 'invalid_request_error', 'model_not_found');
          }
          agentId = match.id;
        }

        // ── function-tool path ────────────────────────────────────────────────
        // When the caller provides FunctionTool definitions, we do a single-step
        // direct model call and return any tool calls to the client for execution
        // (parallel tool use). No session/agent-loop is used — the conversation
        // history is tracked in storedResponses.toolMessages across round trips.
        const functionTools = extractFunctionTools(body.tools ?? []);
        if (functionTools.length > 0) {
          return handleFunctionToolPath(handlers, storedResponses, body, agentId, functionTools);
        }
        // ── end function-tool path ────────────────────────────────────────────

        // Resolve session: x-monad-session-id header > previous_response_id > new
        let sessionId: SessionId;

        if (sessionIdOverride) {
          sessionId = sessionIdOverride;
        } else if (body.previous_response_id) {
          const prev = storedResponses.get(body.previous_response_id);
          if (!prev) {
            return errorResponse(
              `Response not found: ${body.previous_response_id}`,
              404,
              'invalid_request_error',
              'response_not_found'
            );
          }
          sessionId = prev.sessionId;
          prev.lastUsed = Date.now();
        } else {
          try {
            const result = await handlers.session.create({ title: 'responses-api', agentId, origin: SESSION_ORIGIN });
            sessionId = result.sessionId;
          } catch (err) {
            return handlerErrorToResponse(err);
          }
        }

        // Prepend system instructions if provided and this is a new session (no previous_response_id)
        let inputText: string;
        if (body.instructions && !body.previous_response_id && !sessionIdOverride) {
          inputText = `<system>\n${body.instructions}\n</system>\n\n${extractInputText(body.input)}`;
        } else {
          inputText = extractInputText(body.input);
        }

        const ambientContext = buildAmbientContext(body);
        const responseId = newId('resp').replace('_', '-');
        const messageId = newId('msg').replace('_', '-');
        const createdAt = Math.floor(Date.now() / 1000);
        const modelLabel = agentId ?? body.model;

        if (body.stream) {
          return buildStreamingResponse({
            handlers,
            storedResponses,
            encoder,
            body,
            sessionId,
            agentId,
            responseId,
            messageId,
            createdAt,
            modelLabel,
            inputText,
            ambientContext
          });
        }

        // Non-streaming
        let resultText = '';
        let resultUsage: ResponseUsage = {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 }
        };
        let costUsd: number | undefined;
        let resultFinishReason: string | undefined;

        try {
          await handlers.session.sendInline(
            { sessionId, text: inputText },
            (event) => {
              if (event.type === 'agent.message') {
                const p = parseEventPayload('agent.message', event.payload as Record<string, unknown>);
                resultText = p.text;
                resultUsage = buildUsage(p.usage);
                costUsd = p.cost?.usd;
                resultFinishReason = p.finishReason;
              }
            },
            { transport: 'http', ambientContext }
          );
        } catch (err) {
          return handlerErrorToResponse(err);
        }

        const isIncomplete = resultFinishReason === 'max_tokens';
        const outputContent: ResponseOutputText = { type: 'output_text', text: resultText, annotations: [] };
        const outputItem: ResponseOutputMessage = {
          type: 'message',
          id: messageId,
          status: 'completed',
          role: 'assistant',
          content: [outputContent]
        };

        const response: ResponseObject = {
          id: responseId,
          object: 'response',
          created_at: createdAt,
          model: modelLabel,
          status: isIncomplete ? 'incomplete' : 'completed',
          output: [outputItem],
          output_text: computeOutputText([outputItem]),
          error: null,
          incomplete_details: isIncomplete ? { reason: 'max_output_tokens' } : null,
          parallel_tool_calls: false,
          temperature: body.temperature ?? null,
          top_p: body.top_p ?? null,
          tool_choice: 'auto',
          tools: [],
          usage: resultUsage,
          instructions: body.instructions ?? null,
          metadata: body.metadata ?? null,
          previous_response_id: body.previous_response_id ?? null,
          x_monad: { session_id: sessionId, agent_id: agentId, cost_usd: costUsd }
        };

        if (body.store !== false && storedResponses.size < MAX_STORED_RESPONSES) {
          storedResponses.set(responseId, { response, sessionId, lastUsed: Date.now() });
        }

        return jsonResponse(response);
      })
      // ── retrieve response ─────────────────────────────────────────────────────
      .get('/v1/responses/:id', async ({ request, params }) => {
        const block = await guard(request);
        if (block) return block;

        const entry = storedResponses.get(params.id);
        if (!entry)
          return errorResponse(`Response not found: ${params.id}`, 404, 'invalid_request_error', 'response_not_found');
        entry.lastUsed = Date.now();
        return jsonResponse(entry.response);
      })
      // ── delete response ───────────────────────────────────────────────────────
      .delete('/v1/responses/:id', async ({ request, params }) => {
        const block = await guard(request);
        if (block) return block;

        const existed = storedResponses.delete(params.id);
        if (!existed)
          return errorResponse(`Response not found: ${params.id}`, 404, 'invalid_request_error', 'response_not_found');
        return jsonResponse({ id: params.id, object: 'response', deleted: true });
      })
  );
}
