import type { ModelMessage } from '@monad/sdk-atom';
import type {
  EasyInputMessage,
  FunctionTool,
  ResponseFunctionToolCall,
  ResponseInput,
  ResponseInputItem,
  ResponseInputText,
  ResponseOutputMessage,
  ResponseOutputText,
  ResponseUsage
} from 'openai/resources/responses/responses';
import type { ResponsesRequest } from './types.ts';

import { definePrompt } from '#/agent/prompt-template.ts';
import ambientContextPath from './ambient-context.prompt.md' with { type: 'file' };

const AMBIENT_CONTEXT_PROMPT = await definePrompt<{
  jsonOnly: boolean;
  maxOutputTokens?: number;
  temperature?: number;
}>({ id: 'responses-api.ambient-context', sourcePath: ambientContextPath, allowEmpty: true });

export function extractInputText(input: string | ResponseInput): string {
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

export function buildAmbientContext(body: ResponsesRequest): string | undefined {
  const rendered = AMBIENT_CONTEXT_PROMPT.render({
    jsonOnly: body.text?.format?.type === 'json_object',
    ...(body.max_output_tokens ? { maxOutputTokens: body.max_output_tokens } : {}),
    ...(body.temperature != null ? { temperature: body.temperature } : {})
  });
  return rendered || undefined;
}

export function buildUsage(
  usage:
    | {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        reasoningTokens?: number;
      }
    | undefined
): ResponseUsage {
  return {
    input_tokens: usage?.inputTokens ?? 0,
    output_tokens: usage?.outputTokens ?? 0,
    total_tokens: usage?.totalTokens ?? (usage ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) : 0),
    input_tokens_details: {
      cached_tokens: usage?.cacheReadTokens ?? 0,
      cache_write_tokens: usage?.cacheWriteTokens ?? 0
    },
    output_tokens_details: { reasoning_tokens: usage?.reasoningTokens ?? 0 }
  };
}

export function computeOutputText(output: ResponseOutputMessage[]): string {
  return output
    .flatMap((msg) => msg.content)
    .filter((c): c is ResponseOutputText => c.type === 'output_text')
    .map((c) => c.text)
    .join('');
}

// ── function tool helpers ─────────────────────────────────────────────────────

/** Extract client-provided FunctionTool definitions from the request (filters out built-in types). */
export function extractFunctionTools(tools: ResponsesRequest['tools']): FunctionTool[] {
  if (!tools) return [];
  return tools.filter((t): t is FunctionTool => t.type === 'function');
}

/**
 * Build a ModelMessage array from OpenAI ResponseInput, including function_call and
 * function_call_output items so the model sees the full tool-use history.
 * `system` is prepended as the first message when present.
 */
export function buildMessagesFromInput(
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
