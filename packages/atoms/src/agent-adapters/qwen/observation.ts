import type { ExternalAgentObservationEvent } from '@monad/protocol';
import type {
  ExternalAgentObservationJsonRecordEntry,
  ExternalAgentObservationProjector,
  ObservationRole
} from '../observation-projection.ts';

import {
  classifyObservationActivity,
  isStreamingObservationFragment,
  observation,
  permissionDenialEvents,
  rawTextValue,
  resultMarkerText,
  textValue,
  thinkingObservation
} from '../observation-projection.ts';

export type QwenObservationMessage = Record<string, unknown> & { type: string };
type QwenTranscriptMessage = QwenObservationMessage & {
  type: 'assistant' | 'user';
  message?: unknown;
  content?: unknown;
};
type QwenResultMessage = QwenObservationMessage & {
  type: 'result';
  result?: unknown;
  response?: unknown;
  error?: unknown;
  is_error?: boolean;
  permission_denials?: unknown;
  subtype?: unknown;
};
type QwenStreamEventMessage = QwenObservationMessage & { type: 'stream_event'; event?: unknown };
type QwenSystemMessage = QwenObservationMessage & { type: 'system'; subtype?: unknown; error?: unknown };

export function isQwenObservationMessage(record: Record<string, unknown>): record is QwenObservationMessage {
  return typeof record.type === 'string';
}

function isQwenResultMessage(record: QwenObservationMessage): record is QwenResultMessage {
  return record.type === 'result';
}

function isQwenTranscriptMessage(record: QwenObservationMessage): record is QwenTranscriptMessage {
  return record.type === 'assistant' || record.type === 'user';
}

function isQwenStreamEventMessage(record: QwenObservationMessage): record is QwenStreamEventMessage {
  return record.type === 'stream_event';
}

function isQwenSystemMessage(record: QwenObservationMessage): record is QwenSystemMessage {
  return record.type === 'system';
}

function qwenResultText(record: QwenResultMessage): string {
  const error =
    record.error && typeof record.error === 'object' ? (record.error as Record<string, unknown>) : undefined;
  return textValue(record.result, record.response, error?.message) ?? resultMarkerText(record);
}

function qwenContentEvents(args: {
  id: string;
  content: unknown;
  recordIndex: number;
  providerEventType: string;
  raw: unknown;
  textRole: Extract<ObservationRole, 'agent' | 'user'>;
}): ExternalAgentObservationEvent[] {
  if (typeof args.content === 'string') {
    return observation({
      id: `${args.id}:json:${args.recordIndex}:message`,
      role: args.textRole,
      text: args.content,
      source: 'qwen-code-sdk',
      providerEventType: args.providerEventType,
      raw: args.raw
    });
  }
  if (!Array.isArray(args.content)) return [];
  return args.content.flatMap((part, partIndex) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return [];
    const item = part as Record<string, unknown>;
    if (item.type === 'text') {
      return observation({
        id: `${args.id}:json:${args.recordIndex}:message:${partIndex}`,
        role: args.textRole,
        text: textValue(item.text, item.content),
        source: 'qwen-code-sdk',
        providerEventType: args.providerEventType,
        raw: args.raw
      });
    }
    if (item.type === 'thinking' || item.type === 'reasoning') {
      return thinkingObservation({
        id: `${args.id}:json:${args.recordIndex}:thinking:${partIndex}`,
        text: textValue(item.thinking, item.text, item.content),
        source: 'qwen-code-sdk',
        providerEventType: String(item.type),
        raw: args.raw
      });
    }
    if (item.type === 'tool_use') {
      const tool = textValue(item.name, item.tool) ?? 'tool';
      const input = item.input ?? item.args ?? item.arguments;
      const inputText = input === undefined ? '' : ` ${typeof input === 'string' ? input : JSON.stringify(input)}`;
      return observation({
        id: `${args.id}:json:${args.recordIndex}:tool:${partIndex}`,
        role: 'tool',
        text: `Tool call ${tool}${inputText}`,
        source: 'qwen-code-sdk',
        providerEventType: args.providerEventType,
        raw: args.raw
      });
    }
    if (item.type === 'tool_result') {
      return observation({
        id: `${args.id}:json:${args.recordIndex}:tool-result:${partIndex}`,
        role: 'tool',
        text: textValue(item.content, item.output, item.result) ?? JSON.stringify(item.content ?? item),
        source: 'qwen-code-sdk',
        providerEventType: args.providerEventType,
        raw: args.raw
      });
    }
    return [];
  });
}

export function qwenRecordEvents(
  id: string,
  record: QwenObservationMessage,
  recordIndex: number
): ExternalAgentObservationEvent[] {
  const base = recordIndex === 0 ? id : `${id}:json:${recordIndex}`;
  if (isQwenResultMessage(record)) {
    const subtype = textValue(record.subtype);
    return [
      ...observation({
        id: `${base}:result`,
        role: record.is_error ? 'system' : 'agent',
        text: qwenResultText(record),
        source: 'qwen-code-sdk',
        providerEventType: record.is_error && subtype ? subtype : 'result',
        raw: record
      }),
      ...permissionDenialEvents(
        id,
        record.permission_denials,
        'qwen-code-sdk',
        recordIndex === 0 ? undefined : recordIndex
      )
    ];
  }
  if (isQwenTranscriptMessage(record)) {
    const message = record.message;
    const content =
      message && typeof message === 'object' && !Array.isArray(message)
        ? (message as unknown as Record<string, unknown>).content
        : record.content;
    return qwenContentEvents({
      id,
      content,
      recordIndex,
      providerEventType: record.type,
      raw: record,
      textRole: record.type === 'user' ? 'user' : 'agent'
    });
  }
  if (record.type === 'tool_result') {
    return observation({
      id: `${base}:tool-result`,
      role: 'tool',
      text: textValue(record.output, record.result, record.content) ?? JSON.stringify(record),
      source: 'qwen-code-sdk',
      providerEventType: 'tool_result',
      raw: record
    });
  }
  if (isQwenStreamEventMessage(record)) {
    const event = record.event;
    if (!event || typeof event !== 'object' || Array.isArray(event)) return [];
    const e = event as unknown as Record<string, unknown>;
    const delta = e.delta;
    if (e.type === 'content_block_delta' && delta && typeof delta === 'object' && !Array.isArray(delta)) {
      const d = delta as Record<string, unknown>;
      if (d.type === 'thinking_delta' || d.thinking !== undefined) {
        return thinkingObservation({
          id: `${id}:json:${recordIndex}:thinking-delta`,
          text: rawTextValue(d.thinking, d.text),
          source: 'qwen-code-sdk',
          providerEventType: 'thinking_delta',
          raw: record,
          preserveWhitespace: true
        });
      }
      const text = rawTextValue(d.text, d.thinking, d.partial_json);
      const role = d.type === 'input_json_delta' || d.partial_json ? 'tool' : 'agent';
      return observation({
        id: `${id}:json:${recordIndex}:delta`,
        role,
        text,
        source: 'qwen-code-sdk',
        providerEventType: String(e.type),
        raw: record,
        preserveWhitespace: true
      });
    }
    if (e.type === 'content_block_start') {
      const block = e.content_block;
      if (block && typeof block === 'object' && !Array.isArray(block)) {
        const b = block as Record<string, unknown>;
        if (b.type === 'tool_use') {
          return observation({
            id: `${id}:json:${recordIndex}:tool-start`,
            role: 'tool',
            text: `Tool call ${textValue(b.name) ?? 'tool'}`,
            source: 'qwen-code-sdk',
            providerEventType: String(e.type),
            raw: record
          });
        }
      }
    }
  }
  if (isQwenSystemMessage(record)) {
    return observation({
      id: `${id}:json:${recordIndex}:system`,
      role: 'system',
      text: textValue(record.subtype, record.error),
      source: 'qwen-code-sdk',
      providerEventType: 'system',
      raw: record
    });
  }
  return [];
}

function qwenHistoryEntries(
  entries: ExternalAgentObservationJsonRecordEntry[]
): ExternalAgentObservationJsonRecordEntry[] {
  return entries.filter((entry) => entry.record.type !== 'stream_event');
}

export const qwenObservationProjection = {
  historyEntries: qwenHistoryEntries,
  classifyActivity: classifyObservationActivity,
  isStreamingFragment: isStreamingObservationFragment,
  recordProjectors: [
    {
      supports: isQwenObservationMessage,
      parse: ({ id, record, recordIndex }) =>
        isQwenObservationMessage(record) ? qwenRecordEvents(id, record, recordIndex) : []
    }
  ]
} satisfies ExternalAgentObservationProjector;
