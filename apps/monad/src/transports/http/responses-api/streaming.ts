import type { AgentId, SessionId } from '@monad/protocol';
import type { ResponseOutputMessage, ResponseOutputText } from 'openai/resources/responses/responses';
import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';
import type { ResponseObject, ResponsesRequest, StoredResponse } from './types.ts';

import { parseEventPayload } from '@monad/protocol';

import { HandlerError } from '#/handlers/handler-error.ts';
import { SSE_RESPONSE_HEADERS } from '#/transports/http/sessions/sse.ts';
import { buildUsage, computeOutputText } from './input.ts';
import { CORS_HEADERS, MAX_STORED_RESPONSES, MAX_STREAMING_BACKLOG, sseFrame } from './shared.ts';

export function buildStreamingResponse(params: {
  handlers: ReturnType<typeof createDaemonHandlers>;
  storedResponses: Map<string, StoredResponse>;
  encoder: TextEncoder;
  body: ResponsesRequest;
  sessionId: SessionId;
  agentId: AgentId | undefined;
  responseId: string;
  messageId: string;
  createdAt: number;
  modelLabel: string;
  inputText: string;
  ambientContext: string | undefined;
}): Response {
  const {
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
  } = params;

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
                sseFrame('response.completed', { type: 'response.completed', response: completedResponse }, encoder)
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
