import type { AgentId, SessionId } from '@monad/protocol';
import type { ModelMessage } from '@monad/sdk-atom';
import type {
  FunctionTool,
  Response as OAIResponse,
  ResponseFunctionToolCall,
  ResponseOutputMessage
} from 'openai/resources/responses/responses';
import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';
import type { ResponseObject, ResponsesRequest, StoredResponse } from './types.ts';

import { newId } from '@monad/protocol';

import { buildMessagesFromInput, buildUsage } from './input.ts';
import { errorResponse, jsonResponse, MAX_STORED_RESPONSES } from './shared.ts';

/**
 * When the caller provides FunctionTool definitions, we do a single-step
 * direct model call and return any tool calls to the client for execution
 * (parallel tool use). No session/agent-loop is used — the conversation
 * history is tracked in storedResponses.toolMessages across round trips.
 */
export async function handleFunctionToolPath(
  handlers: ReturnType<typeof createDaemonHandlers>,
  storedResponses: Map<string, StoredResponse>,
  body: ResponsesRequest,
  agentId: AgentId | undefined,
  functionTools: FunctionTool[]
): Promise<Response> {
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
