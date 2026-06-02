import type { AgentId, SessionId } from '@monad/protocol';
import type { ModelMessage } from '@monad/sdk-atom';
import type {
  EasyInputMessage,
  FunctionTool,
  Response as OAIResponse,
  ResponseCreateParamsBase,
  ResponseFunctionToolCall,
  ResponseInput,
  ResponseInputItem,
  ResponseInputText,
  ResponseOutputMessage,
  ResponseOutputText,
  ResponseUsage
} from 'openai/resources/responses/responses';
import type { createDaemonHandlers } from '@/handlers/handlers.ts';
import type { OpenAiCompatConfig } from '@/transports/http/openai-compat.ts';

import { timingSafeEqual } from 'node:crypto';
import { newId, parseEventPayload } from '@monad/protocol';
import { Elysia } from 'elysia';

import { HANDLER_ERROR_MAP, HandlerError } from '@/handlers/handler-error.ts';
import { buildSessionOrigin } from '@/handlers/session/origin.ts';
import { SSE_RESPONSE_HEADERS } from '@/transports/http/sessions/sse.ts';

// ── Responses API wire types ──────────────────────────────────────────────────
// All openai SDK imports are type-only — erased at bundle time.

// Intersection narrows the SDK base to enforce the fields our handler requires.
type ResponsesRequest = ResponseCreateParamsBase & {
  model: string;
  input: string | ResponseInput;
  stream?: boolean | null;
};

// OAIResponse covers every required field the OpenAI wire format mandates.
// x_monad is our vendor extension for session/agent/cost metadata.
type ResponseObject = OAIResponse & { x_monad?: { session_id: string; agent_id?: string; cost_usd?: number } };

// ── constants ─────────────────────────────────────────────────────────────────

const RESPONSE_TTL_MS = 24 * 60 * 60 * 1000;
const RESPONSE_GC_INTERVAL_MS = 30 * 60 * 1000;
const MAX_STREAMING_BACKLOG = 512;
const MAX_STORED_RESPONSES = 10_000;

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization, x-monad-agent-id, x-monad-session-id',
  'access-control-max-age': '86400'
};

const SESSION_ORIGIN = buildSessionOrigin({ transport: 'http', surface: 'api', client: 'responses-api' });

// ── helpers ───────────────────────────────────────────────────────────────────

function errorResponse(message: string, status = 400, type = 'invalid_request_error', code?: string): Response {
  return new Response(JSON.stringify({ error: { message, type, ...(code ? { code } : {}) } }), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS }
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...CORS_HEADERS }
  });
}

function checkToken(request: Request, token: string): boolean {
  const header = request.headers.get('authorization') ?? '';
  const expected = `Bearer ${token}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  const len = Math.max(a.length, b.length, 1);
  const pa = Buffer.concat([a, Buffer.alloc(len - a.length)]);
  const pb = Buffer.concat([b, Buffer.alloc(len - b.length)]);
  return timingSafeEqual(pa, pb) && a.length === b.length;
}

function handlerErrorToResponse(err: unknown): Response {
  if (err instanceof HandlerError) {
    const { httpStatus } = HANDLER_ERROR_MAP[err.kind];
    return errorResponse(err.message, httpStatus, 'api_error', err.kind);
  }
  throw err;
}

function extractInputText(input: string | ResponseInput): string {
  if (typeof input === 'string') return input;
  const parts: string[] = [];
  for (const item of input) {
    if (!('role' in item) || !('content' in item)) continue;
    const msg = item as EasyInputMessage;
    const text =
      typeof msg.content === 'string'
        ? msg.content
        : (msg.content as ResponseInputText[])
            .filter((p): p is ResponseInputText => p.type === 'input_text')
            .map((p) => p.text)
            .join('\n');
    if (msg.role === 'system') {
      parts.push(`<system>\n${text}\n</system>`);
    } else if (msg.role === 'user') {
      parts.push(text);
    } else {
      parts.push(`Assistant: ${text}`);
    }
  }
  return parts.join('\n\n');
}

function buildAmbientContext(body: ResponsesRequest): string | undefined {
  const hints: string[] = [];
  if (body.max_output_tokens) hints.push(`Limit your response to at most ${body.max_output_tokens} tokens.`);
  if (body.text?.format?.type === 'json_object') {
    hints.push('Respond with valid JSON only. Do not include any text outside the JSON object.');
  }
  if (body.temperature != null) {
    if (body.temperature < 0.3) hints.push('Be precise and deterministic. Avoid creative embellishments.');
    else if (body.temperature > 0.8) hints.push('Be creative and exploratory in your response.');
  }
  return hints.length > 0 ? hints.join('\n') : undefined;
}

function buildUsage(
  usage:
    | {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        cacheReadTokens?: number;
        reasoningTokens?: number;
      }
    | undefined
): ResponseUsage {
  return {
    input_tokens: usage?.inputTokens ?? 0,
    output_tokens: usage?.outputTokens ?? 0,
    total_tokens: usage?.totalTokens ?? (usage ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) : 0),
    input_tokens_details: { cached_tokens: usage?.cacheReadTokens ?? 0 },
    output_tokens_details: { reasoning_tokens: usage?.reasoningTokens ?? 0 }
  };
}

function computeOutputText(output: ResponseOutputMessage[]): string {
  return output
    .flatMap((msg) => msg.content)
    .filter((c): c is ResponseOutputText => c.type === 'output_text')
    .map((c) => c.text)
    .join('');
}

function sseFrame(eventType: string, data: unknown, encoder: TextEncoder): Uint8Array {
  return encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ── function tool helpers ─────────────────────────────────────────────────────

/** Extract client-provided FunctionTool definitions from the request (filters out built-in types). */
function extractFunctionTools(tools: ResponsesRequest['tools']): FunctionTool[] {
  if (!tools) return [];
  return tools.filter((t): t is FunctionTool => t.type === 'function');
}

/**
 * Build a ModelMessage array from OpenAI ResponseInput, including function_call and
 * function_call_output items so the model sees the full tool-use history.
 * `system` is prepended as the first message when present.
 */
function buildMessagesFromInput(
  input: string | ResponseInput,
  system?: string | null,
  prevMessages?: ModelMessage[]
): ModelMessage[] {
  const messages: ModelMessage[] = [];
  if (system) messages.push({ role: 'system', content: system });
  // Carry forward history from a previous tool-calling step (not a full session turn —
  // just the assistant + tool messages from the last model call).
  if (prevMessages) messages.push(...prevMessages);

  if (typeof input === 'string') {
    if (input) messages.push({ role: 'user', content: input });
    return messages;
  }

  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const type = (item as { type?: string }).type;

    // function_call_output: tool result from the client
    if (type === 'function_call_output') {
      const fc = item as ResponseInputItem.FunctionCallOutput;
      messages.push({
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: fc.call_id, toolName: '', output: String(fc.output ?? '') }]
      });
      continue;
    }

    // function_call (assistant requesting a tool): comes back in continuation input
    if (type === 'function_call') {
      const fc = item as ResponseFunctionToolCall;
      messages.push({
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: fc.call_id,
            toolName: fc.name,
            input: (() => {
              try {
                return JSON.parse(fc.arguments || '{}');
              } catch {
                return {};
              }
            })()
          }
        ]
      });
      continue;
    }

    // Standard message (user / assistant / system)
    if ('role' in item && 'content' in item) {
      const msg = item as EasyInputMessage;
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : (msg.content as ResponseInputText[])
              .filter((p): p is ResponseInputText => p.type === 'input_text')
              .map((p) => p.text)
              .join('\n');
      const role = msg.role === 'system' ? 'system' : msg.role === 'assistant' ? 'assistant' : 'user';
      if (text) messages.push({ role, content: text });
    }
  }
  return messages;
}

// ── controller factory ────────────────────────────────────────────────────────

export function createResponsesApiController(
  handlers: ReturnType<typeof createDaemonHandlers>,
  encoder: TextEncoder,
  getConfig: () => Promise<OpenAiCompatConfig>
  // biome-ignore lint/suspicious/noExplicitAny: Elysia's route generic conflicts with plugin signature; cast is safe at runtime
): Elysia<any, any, any, any, any, any, any> {
  type StoredResponse = {
    response: ResponseObject;
    sessionId: SessionId;
    lastUsed: number;
    /** Message history for function-tool mode (no session used). */
    toolMessages?: ModelMessage[];
  };
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
        'OpenAI-compat API is disabled. Set openaiCompat.enabled=true in profile.json.',
        404,
        'api_error',
        'disabled'
      );
    }
    if (!config.token) {
      return errorResponse(
        'OpenAI-compatible Responses API requires a token. Set openaiCompat.token in profile.json.',
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
          const prevEntry = body.previous_response_id ? storedResponses.get(body.previous_response_id) : undefined;
          if (body.previous_response_id && !prevEntry) {
            return errorResponse(
              `Response not found: ${body.previous_response_id}`,
              404,
              'invalid_request_error',
              'response_not_found'
            );
          }
          if (prevEntry) prevEntry.lastUsed = Date.now();
          const prevMessages = prevEntry?.toolMessages;
          const messages = buildMessagesFromInput(body.input, body.instructions, prevMessages);
          const toolSpecs = functionTools.map((t) => ({
            name: t.name,
            description: t.description ?? '',
            parameters: (t.parameters as Record<string, unknown> | undefined) ?? { type: 'object', properties: {} }
          }));
          const responseId = newId('resp').replace('_', '-');
          const createdAt = Math.floor(Date.now() / 1000);
          const modelLabel = agentId ?? body.model;
          let result: Awaited<ReturnType<typeof handlers.modelDirect.complete>>;
          try {
            result = await handlers.modelDirect.complete(messages, toolSpecs, agentId ?? undefined);
          } catch (err) {
            return errorResponse(err instanceof Error ? err.message : String(err), 500, 'api_error', 'model_error');
          }

          const toolCalls = result.toolCalls ?? [];
          const hasParallelCalls = toolCalls.length > 1;
          const output: Array<ResponseOutputMessage | ResponseFunctionToolCall> = [];

          // Accumulate the new assistant turn into message history for subsequent requests that
          // carry `previous_response_id`. Exclude the leading system message: buildMessagesFromInput
          // always re-prepends it from body.instructions, so storing it here would double it on the
          // next round (and triple it the round after that).
          const historyStart = body.instructions ? 1 : 0;
          const assistantContent =
            toolCalls.length > 0
              ? [
                  ...(result.text ? [{ type: 'text' as const, text: result.text }] : []),
                  ...toolCalls.map((c) => ({
                    type: 'tool-call' as const,
                    toolCallId: c.toolCallId,
                    toolName: c.toolName,
                    input: c.input
                  }))
                ]
              : result.text;
          const nextMessages: ModelMessage[] = [
            ...messages.slice(historyStart),
            ...(assistantContent ? [{ role: 'assistant' as const, content: assistantContent }] : [])
          ];

          if (result.text) {
            const msgId = newId('msg').replace('_', '-');
            output.push({
              type: 'message',
              id: msgId,
              status: 'completed',
              role: 'assistant',
              content: [{ type: 'output_text', text: result.text, annotations: [] }]
            } as ResponseOutputMessage);
          }
          for (const call of toolCalls) {
            output.push({
              type: 'function_call',
              id: newId('fc').replace('_', '-'),
              call_id: call.toolCallId,
              name: call.toolName,
              arguments: typeof call.input === 'string' ? call.input : JSON.stringify(call.input),
              status: 'completed'
            } as ResponseFunctionToolCall);
          }

          const isIncomplete = result.finishReason === 'length';
          const response: ResponseObject = {
            id: responseId,
            object: 'response',
            created_at: createdAt,
            model: modelLabel,
            status: isIncomplete ? 'incomplete' : 'completed',
            output,
            output_text: result.text ?? '',
            error: null,
            incomplete_details: isIncomplete ? { reason: 'max_output_tokens' } : null,
            parallel_tool_calls: hasParallelCalls,
            temperature: body.temperature ?? null,
            top_p: body.top_p ?? null,
            tool_choice: body.tool_choice ?? 'auto',
            tools: (body.tools ?? []) as OAIResponse['tools'],
            usage: buildUsage(result.usage),
            instructions: body.instructions ?? null,
            metadata: body.metadata ?? null,
            previous_response_id: body.previous_response_id ?? null
          };

          if (body.store !== false && storedResponses.size < MAX_STORED_RESPONSES) {
            // sessionId is irrelevant in tool mode — store empty string as placeholder
            storedResponses.set(responseId, {
              response,
              sessionId: '' as SessionId,
              lastUsed: Date.now(),
              toolMessages: nextMessages
            });
          }
          return jsonResponse(response);
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
          const stream = new ReadableStream<Uint8Array>({
            async start(ctrl) {
              let dropped = false;
              let accumulatedText = '';

              const enqueue = (frame: Uint8Array) => {
                if (!dropped && ctrl.desiredSize !== null) ctrl.enqueue(frame);
              };

              try {
                // response.created
                const initialResponse: ResponseObject = {
                  id: responseId,
                  object: 'response',
                  created_at: createdAt,
                  model: modelLabel,
                  status: 'in_progress',
                  output: [],
                  output_text: '',
                  error: null,
                  incomplete_details: null,
                  parallel_tool_calls: false,
                  temperature: body.temperature ?? null,
                  top_p: body.top_p ?? null,
                  tool_choice: 'auto',
                  tools: [],
                  instructions: body.instructions ?? null,
                  metadata: body.metadata ?? null,
                  previous_response_id: body.previous_response_id ?? null
                };
                enqueue(sseFrame('response.created', { type: 'response.created', response: initialResponse }, encoder));

                // response.output_item.added
                const outputItemInProgress: ResponseOutputMessage = {
                  type: 'message',
                  id: messageId,
                  status: 'in_progress',
                  role: 'assistant',
                  content: []
                };
                enqueue(
                  sseFrame(
                    'response.output_item.added',
                    { type: 'response.output_item.added', output_index: 0, item: outputItemInProgress },
                    encoder
                  )
                );

                // response.content_part.added
                enqueue(
                  sseFrame(
                    'response.content_part.added',
                    {
                      type: 'response.content_part.added',
                      item_id: messageId,
                      output_index: 0,
                      content_index: 0,
                      part: { type: 'output_text', text: '', annotations: [] }
                    },
                    encoder
                  )
                );

                await handlers.session.sendInline(
                  { sessionId, text: inputText },
                  (event) => {
                    if (dropped || ctrl.desiredSize === null) return;

                    if (event.type === 'agent.token') {
                      const p = parseEventPayload('agent.token', event.payload as Record<string, unknown>);
                      accumulatedText += p.delta;
                      enqueue(
                        sseFrame(
                          'response.output_text.delta',
                          {
                            type: 'response.output_text.delta',
                            item_id: messageId,
                            output_index: 0,
                            content_index: 0,
                            delta: p.delta
                          },
                          encoder
                        )
                      );
                    } else if (event.type === 'agent.message') {
                      const p = parseEventPayload('agent.message', event.payload as Record<string, unknown>);
                      accumulatedText = p.text;
                      const isIncomplete = p.finishReason === 'max_tokens';

                      // response.output_text.done
                      enqueue(
                        sseFrame(
                          'response.output_text.done',
                          {
                            type: 'response.output_text.done',
                            item_id: messageId,
                            output_index: 0,
                            content_index: 0,
                            text: accumulatedText
                          },
                          encoder
                        )
                      );

                      const contentPart: ResponseOutputText = {
                        type: 'output_text',
                        text: accumulatedText,
                        annotations: []
                      };
                      const completedItem: ResponseOutputMessage = {
                        type: 'message',
                        id: messageId,
                        status: 'completed',
                        role: 'assistant',
                        content: [contentPart]
                      };
                      const usage = buildUsage(p.usage);
                      const completedResponse: ResponseObject = {
                        id: responseId,
                        object: 'response',
                        created_at: createdAt,
                        model: modelLabel,
                        status: isIncomplete ? 'incomplete' : 'completed',
                        output: [completedItem],
                        output_text: computeOutputText([completedItem]),
                        error: null,
                        incomplete_details: isIncomplete ? { reason: 'max_output_tokens' } : null,
                        parallel_tool_calls: false,
                        temperature: body.temperature ?? null,
                        top_p: body.top_p ?? null,
                        tool_choice: 'auto',
                        tools: [],
                        usage,
                        instructions: body.instructions ?? null,
                        metadata: body.metadata ?? null,
                        previous_response_id: body.previous_response_id ?? null,
                        x_monad: { session_id: sessionId, agent_id: agentId, cost_usd: p.cost?.usd }
                      };

                      // response.content_part.done
                      enqueue(
                        sseFrame(
                          'response.content_part.done',
                          {
                            type: 'response.content_part.done',
                            item_id: messageId,
                            output_index: 0,
                            content_index: 0,
                            part: contentPart
                          },
                          encoder
                        )
                      );

                      // response.output_item.done
                      enqueue(
                        sseFrame(
                          'response.output_item.done',
                          {
                            type: 'response.output_item.done',
                            output_index: 0,
                            item: completedItem
                          },
                          encoder
                        )
                      );

                      // response.completed
                      enqueue(
                        sseFrame(
                          'response.completed',
                          { type: 'response.completed', response: completedResponse },
                          encoder
                        )
                      );

                      if (body.store !== false && storedResponses.size < MAX_STORED_RESPONSES) {
                        storedResponses.set(responseId, {
                          response: completedResponse,
                          sessionId,
                          lastUsed: Date.now()
                        });
                      }
                    }

                    if (!dropped && (ctrl.desiredSize ?? 0) < -MAX_STREAMING_BACKLOG) {
                      dropped = true;
                      void handlers.session.abort({ id: sessionId });
                      try {
                        ctrl.close();
                      } catch {}
                    }
                  },
                  { transport: 'http', ambientContext }
                );
              } catch (err) {
                try {
                  const msg = err instanceof HandlerError ? err.message : 'An internal error occurred.';
                  ctrl.enqueue(
                    sseFrame(
                      'error',
                      { type: 'error', error: { message: msg, type: 'api_error', code: 'stream_error' } },
                      encoder
                    )
                  );
                } catch {}
              } finally {
                if (!dropped) {
                  try {
                    ctrl.close();
                  } catch {}
                }
              }
            },
            cancel() {
              void handlers.session.abort({ id: sessionId });
            }
          });
          return new Response(stream, { headers: { ...SSE_RESPONSE_HEADERS, ...CORS_HEADERS } });
        }

        // Non-streaming
        let resultText = '';
        let resultUsage: ResponseUsage = {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          input_tokens_details: { cached_tokens: 0 },
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
