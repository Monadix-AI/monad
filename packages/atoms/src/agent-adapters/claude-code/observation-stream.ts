import type { MeshAgentObservationEvent } from '@monad/protocol';

import { numberValue, recordValue, textValue } from '../observation-projection.ts';

type ClaudeBlock = {
  eventIndex: number;
  inputJson?: string;
  text?: string;
  toolName?: string;
};

type ClaudeBlockType = 'text' | 'thinking' | 'tool';

function streamEvent(event: MeshAgentObservationEvent): Record<string, unknown> | undefined {
  const raw = recordValue(event.provenance.rawEvents[0]);
  return raw?.type === 'stream_event' ? recordValue(raw.event) : undefined;
}

function transcriptMessage(record: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return record?.type === 'assistant' ? recordValue(record.message) : undefined;
}

function finalPartIndex(event: MeshAgentObservationEvent): number | undefined {
  const match = /:(?:message|thinking|tool):(\d+)$/.exec(event.id);
  if (!match) return undefined;
  const index = Number(match[1]);
  return Number.isInteger(index) ? index : undefined;
}

function blockType(event: Record<string, unknown> | undefined): ClaudeBlockType | undefined {
  const block = recordValue(event?.content_block);
  if (block?.type === 'thinking') return 'thinking';
  if (block?.type === 'text') return 'text';
  if (block?.type === 'tool_use') return 'tool';
  return undefined;
}

function deltaType(event: Record<string, unknown> | undefined): ClaudeBlockType | undefined {
  const delta = recordValue(event?.delta);
  if (delta?.type === 'thinking_delta' || delta?.thinking !== undefined) return 'thinking';
  if (delta?.type === 'text_delta' || delta?.text !== undefined) return 'text';
  if (delta?.type === 'input_json_delta' || delta?.partial_json !== undefined) return 'tool';
  return undefined;
}

function finalBlockKey(event: MeshAgentObservationEvent): string | undefined {
  const raw = recordValue(event.provenance.rawEvents[0]);
  const message = transcriptMessage(raw);
  const messageId = textValue(message?.id);
  const partIndex = finalPartIndex(event);
  const content = Array.isArray(message?.content) ? message.content : [];
  const part = partIndex === undefined ? undefined : recordValue(content[partIndex]);
  const toolUseId = part?.type === 'tool_use' ? textValue(part.id) : undefined;
  if (toolUseId) return `tool:${toolUseId}`;
  return messageId && partIndex !== undefined ? `${messageId}:${partIndex}` : undefined;
}

export function reconcileClaudeStreamEvents(events: MeshAgentObservationEvent[]): MeshAgentObservationEvent[] {
  const reconciled: MeshAgentObservationEvent[] = [];
  const blocks = new Map<string, ClaudeBlock>();
  let activeMessageId: string | undefined;
  let activeThinkingKey: string | undefined;
  let tokenEventIndex: number | undefined;

  for (const event of events) {
    const raw = recordValue(event.provenance.rawEvents[0]);
    const native = streamEvent(event);
    if (native?.type === 'message_start') {
      activeMessageId = textValue(recordValue(native.message)?.id);
      continue;
    }
    if (native?.type === 'content_block_start') {
      const index = numberValue(native.index);
      const type = blockType(native);
      if (activeMessageId && index !== undefined && type) {
        const key = `${activeMessageId}:${index}`;
        if (type === 'thinking') {
          activeThinkingKey = key;
          const eventIndex =
            reconciled.push({
              ...event,
              role: 'agent',
              text: 'Thinking…',
              hasContent: false,
              providerEventType: 'thinking_delta'
            }) - 1;
          blocks.set(key, { eventIndex, text: '' });
        }
        if (type === 'tool') {
          const block = recordValue(native.content_block);
          const toolName = textValue(block?.name) ?? 'tool';
          const toolUseId = textValue(block?.id);
          const input = block?.input;
          const inputText = input === undefined ? '' : ` ${typeof input === 'string' ? input : JSON.stringify(input)}`;
          const eventIndex =
            reconciled.push({
              ...event,
              role: 'tool',
              text: `Tool call ${toolName}${inputText}`,
              providerEventType: 'tool_use_delta'
            }) - 1;
          const state = { eventIndex, inputJson: '', toolName };
          blocks.set(key, state);
          if (toolUseId) blocks.set(`tool:${toolUseId}`, state);
        }
      }
      continue;
    }
    if (native?.type === 'content_block_stop') {
      const index = numberValue(native.index);
      const key = activeMessageId && index !== undefined ? `${activeMessageId}:${index}` : undefined;
      const existing = key ? blocks.get(key) : undefined;
      if (existing && key === activeThinkingKey) {
        const previous = reconciled[existing.eventIndex];
        if (previous) {
          reconciled[existing.eventIndex] = {
            ...previous,
            providerEventType: 'thinking',
            provenance: {
              rawEvents: [...previous.provenance.rawEvents, ...event.provenance.rawEvents]
            }
          };
        }
      }
      activeThinkingKey = undefined;
      continue;
    }
    if (native?.type === 'message_delta' || native?.type === 'message_stop') {
      activeThinkingKey = undefined;
      activeMessageId = undefined;
      continue;
    }
    if (raw?.type === 'stream_event' && !native) continue;

    const nativeIndex = numberValue(native?.index);
    const nativeType = deltaType(native);
    if (native?.type === 'content_block_delta' && nativeType) {
      if (activeMessageId && nativeIndex !== undefined) {
        const key = `${activeMessageId}:${nativeIndex}`;
        const existing = blocks.get(key);
        if (existing) {
          const previous = reconciled[existing.eventIndex];
          if (previous) {
            const delta = recordValue(native.delta);
            if (nativeType === 'tool')
              existing.inputJson = `${existing.inputJson ?? ''}${String(delta?.partial_json ?? '')}`;
            if (nativeType === 'thinking' || nativeType === 'text') {
              const fragment =
                typeof delta?.thinking === 'string'
                  ? delta.thinking
                  : typeof delta?.text === 'string'
                    ? delta.text
                    : event.text;
              existing.text = `${existing.text ?? (previous.hasContent === false ? '' : previous.text)}${fragment}`;
            }
            reconciled[existing.eventIndex] = {
              ...previous,
              text:
                nativeType === 'tool'
                  ? `Tool call ${existing.toolName ?? 'tool'}${existing.inputJson ? ` ${existing.inputJson}` : ''}`
                  : (existing.text ?? previous.text),
              ...(nativeType === 'thinking' ? { hasContent: true } : {}),
              ...(nativeType === 'tool' ? { providerEventType: 'tool_use_delta' } : {}),
              provenance: {
                rawEvents: [...previous.provenance.rawEvents, ...event.provenance.rawEvents]
              }
            };
          }
        } else {
          const eventIndex = reconciled.push(event) - 1;
          blocks.set(key, { eventIndex });
        }
        if (nativeType === 'thinking') activeThinkingKey = key;
      } else {
        reconciled.push(event);
      }
      continue;
    }

    if (raw?.type === 'system' && raw.subtype === 'thinking_tokens') {
      const estimatedTokens = numberValue(raw.estimated_tokens);
      const target = activeThinkingKey ? blocks.get(activeThinkingKey)?.eventIndex : tokenEventIndex;
      if (target !== undefined) {
        const previous = reconciled[target];
        if (previous) {
          reconciled[target] = {
            ...previous,
            ...(estimatedTokens === undefined ? {} : { summary: `Thinking… ${Math.trunc(estimatedTokens)} tokens` }),
            provenance: { rawEvents: [...previous.provenance.rawEvents, ...event.provenance.rawEvents] }
          };
        }
      } else {
        tokenEventIndex = reconciled.push(event) - 1;
      }
      continue;
    }

    if (event.role === 'tool' || event.role === 'user') {
      activeThinkingKey = undefined;
      tokenEventIndex = undefined;
    }

    const finalKey = finalBlockKey(event);
    if (finalKey) {
      const existing = blocks.get(finalKey);
      if (existing) {
        const previous = reconciled[existing.eventIndex];
        reconciled[existing.eventIndex] = {
          ...event,
          id: previous?.id ?? event.id,
          ...(previous?.summary ? { summary: previous.summary } : {}),
          provenance: {
            rawEvents: [...(previous?.provenance.rawEvents ?? []), ...event.provenance.rawEvents]
          }
        };
        continue;
      }
      blocks.set(finalKey, { eventIndex: reconciled.push(event) - 1 });
      continue;
    }

    if (raw?.type === 'stream_event') continue;
    reconciled.push(event);
  }

  return reconciled;
}
