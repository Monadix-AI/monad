import type { NativeCliObservationEvent } from '@monad/protocol';
import type {
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage
} from '@qwen-code/sdk';

import {
  contentEvents,
  observation,
  permissionDenialEvents,
  rawTextValue,
  resultMarkerText,
  textValue
} from './native-cli-observation-shared.ts';

export type QwenObservationMessage = Record<string, unknown> & { type: string };
type QwenTranscriptMessage = Partial<SDKAssistantMessage | SDKUserMessage> &
  Record<string, unknown> & { type: 'assistant' | 'user' };
type QwenResultMessage = Partial<SDKResultMessage> & Record<string, unknown> & { type: 'result' };
type QwenStreamEventMessage = Partial<SDKPartialAssistantMessage> & Record<string, unknown> & { type: 'stream_event' };
type QwenSystemMessage = Partial<SDKSystemMessage> & Record<string, unknown> & { type: 'system' };

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

export function qwenRecordEvents(
  id: string,
  record: QwenObservationMessage,
  recordIndex: number
): NativeCliObservationEvent[] {
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
    return contentEvents({
      id,
      content,
      recordIndex,
      source: 'qwen-code-sdk',
      providerEventType: record.type,
      raw: record
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
