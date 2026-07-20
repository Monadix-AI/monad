// Pure translation between monad's event/prompt model and ACP wire types.
// Kept side-effect-free so it can be unit-tested without a live connection.

import type { ContentBlock, SessionUpdate, StopReason, ToolKind } from '@agentclientprotocol/sdk';
import type { Event, FinishReason, TokenUsage } from '@monad/protocol';
import type { ImageAttachment } from '#/agent/index.ts';

import { finishReasonSchema, parseEventPayload, tokenUsageSchema } from '@monad/protocol';
import { z } from 'zod';

const planResultSchema = z.object({
  todos: z.array(z.object({ content: z.string(), status: z.enum(['pending', 'in_progress', 'completed']) }))
});

export function canonicalTerminalMetadata(data: unknown): { finishReason?: FinishReason; usage?: TokenUsage } {
  if (!data || typeof data !== 'object') return {};
  const candidate = data as { finishReason?: unknown; usage?: unknown };
  const finishReason = finishReasonSchema.safeParse(candidate.finishReason);
  const usage = tokenUsageSchema.safeParse(candidate.usage);
  return {
    ...(finishReason.success ? { finishReason: finishReason.data } : {}),
    ...(usage.success ? { usage: usage.data } : {})
  };
}

function usageUpdate(usage: TokenUsage | undefined): SessionUpdate | null {
  if (!usage) return null;
  return {
    sessionUpdate: 'usage_update',
    used: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    size: usage.totalTokens ?? 0
  };
}

/** Flatten an ACP prompt (content blocks) into the plain text monad's loop consumes.
 * Non-text blocks are rendered as a stable textual placeholder so the model still sees
 * that context existed; richer handling (images, embedded resources) lands with P2-B. */
export function promptToText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        parts.push(block.text);
        break;
      case 'resource_link':
        parts.push(`[resource: ${block.uri}]`);
        break;
      case 'resource': {
        const r = block.resource;
        // Inline text content if present and non-empty; otherwise fall back to a uri placeholder.
        if ('text' in r && typeof r.text === 'string' && r.text) parts.push(r.text);
        else if ('uri' in r) parts.push(`[resource: ${r.uri}]`);
        break;
      }
      case 'image':
        parts.push('[image]');
        break;
      case 'audio':
        parts.push('[audio]');
        break;
    }
  }
  return parts.join('\n');
}

/** Extract image content blocks from an ACP prompt as transient model attachments for this turn.
 * ACP image data is base64; the model layer takes raw bytes. */
export function promptToAttachments(blocks: ContentBlock[]): ImageAttachment[] {
  const out: ImageAttachment[] = [];
  for (const block of blocks) {
    if (block.type === 'image' && typeof block.data === 'string') {
      out.push({ image: new Uint8Array(Buffer.from(block.data, 'base64')), mediaType: block.mimeType });
    }
  }
  return out;
}

/** monad's FinishReason enum is value-identical to ACP's StopReason. */
export function finishReasonToStopReason(reason: FinishReason | undefined): StopReason {
  return (reason ?? 'end_turn') as StopReason;
}

/** Map a monad built-in tool name to an ACP ToolKind so clients pick sensible icons/UI. */
export function toolKind(toolName: string): ToolKind {
  if (toolName === 'file_read') return 'read';
  if (toolName === 'file_write' || toolName === 'file_patch') return 'edit';
  if (toolName === 'file_glob' || toolName === 'file_grep' || toolName.includes('search')) return 'search';
  if (toolName.startsWith('shell') || toolName.startsWith('process') || toolName === 'code_execute') return 'execute';
  if (toolName.startsWith('web') || toolName.startsWith('net') || toolName.startsWith('fetch')) return 'fetch';
  if (toolName === 'skill' || toolName === 'clarify_ask') return 'think';
  return 'other';
}

/** A monad `todo_write` tool result → an ACP `plan` update, so the editor renders monad's task
 * list as a live checklist. Returns null for any other event. Emitted *in addition to* the normal
 * tool_call_update (so `eventToSessionUpdate` stays a clean 1:1). */
export function eventToPlanUpdate(event: Event): SessionUpdate | null {
  if (event.type !== 'tool.result') return null;
  const { tool, ok, result } = parseEventPayload('tool.result', event.payload);
  if (tool !== 'todo_write' || !ok) return null;
  try {
    const parsed = planResultSchema.parse(JSON.parse(result));
    return {
      sessionUpdate: 'plan',
      entries: parsed.todos.map((t) => ({ content: t.content, priority: 'medium' as const, status: t.status }))
    };
  } catch {
    return null;
  }
}

/** Translate a monad domain event into the matching ACP `session/update` payload.
 *
 * Returns `null` for events that have no streaming-update analogue (lifecycle changes,
 * and the approval/clarify events the connection intercepts out-of-band for reverse-RPC).
 */
export function eventToSessionUpdate(event: Event): SessionUpdate | null {
  switch (event.type) {
    case 'session.message.delta.appended': {
      const { channel, delta, messageId } = parseEventPayload('session.message.delta.appended', event.payload);
      if (!delta) return null;
      return {
        sessionUpdate: channel === 'reasoning' ? 'agent_thought_chunk' : 'agent_message_chunk',
        content: { type: 'text', text: delta },
        messageId
      };
    }
    case 'session.message.completed': {
      const { message } = parseEventPayload('session.message.completed', event.payload);
      return usageUpdate(canonicalTerminalMetadata(message.data).usage);
    }
    case 'tool.called': {
      const { toolCallId, tool, input } = parseEventPayload('tool.called', event.payload);
      // A `path` argument (fs.*/shell cwd) lets clients do follow-along highlighting.
      const path = (input as { path?: unknown } | null)?.path;
      const locations = typeof path === 'string' ? [{ path }] : undefined;
      return {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: tool,
        kind: toolKind(tool),
        status: 'in_progress',
        rawInput: input,
        ...(locations ? { locations } : {})
      };
    }
    case 'tool.progress': {
      // Live partial output → replace the tool call's content with the cumulative output so far.
      const { toolCallId, output } = parseEventPayload('tool.progress', event.payload);
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'in_progress',
        content: [{ type: 'content', content: { type: 'text', text: output } }]
      };
    }
    case 'tool.result': {
      const { toolCallId, ok, result } = parseEventPayload('tool.result', event.payload);
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: ok ? 'completed' : 'failed',
        content: [{ type: 'content', content: { type: 'text', text: result } }],
        rawOutput: result
      };
    }
    case 'session.updated': {
      // A title/metadata change (e.g. another client renamed the session) → push session_info_update.
      const { title } = event.payload as { title?: string };
      if (typeof title !== 'string') return null;
      return { sessionUpdate: 'session_info_update', title };
    }
    default:
      return null;
  }
}
