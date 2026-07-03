import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk';
import type { NativeCliObservationEvent } from '@monad/protocol';

import {
  contentEvents,
  observation,
  permissionDenialEvents,
  rawTextValue,
  resultMarkerText,
  textValue
} from './native-cli-observation-shared.ts';

export type ClaudeObservationMessage = Partial<SDKMessage> & Record<string, unknown> & { type: string };
type ClaudeTranscriptMessage = Partial<SDKAssistantMessage | SDKUserMessage> &
  Record<string, unknown> & { type: 'assistant' | 'user' };
type ClaudeResultMessage = Partial<SDKResultMessage> & Record<string, unknown> & { type: 'result' };
type ClaudeStreamEventMessage = Partial<SDKPartialAssistantMessage> &
  Record<string, unknown> & { type: 'stream_event' };
type ClaudeSystemMessage = Partial<SDKSystemMessage> & Record<string, unknown> & { type: 'system' };

export function isClaudeObservationMessage(record: Record<string, unknown>): record is ClaudeObservationMessage {
  return typeof record.type === 'string';
}

function isClaudeResultMessage(record: ClaudeObservationMessage): record is ClaudeResultMessage {
  return record.type === 'result';
}

function isClaudeTranscriptMessage(record: ClaudeObservationMessage): record is ClaudeTranscriptMessage {
  return record.type === 'assistant' || record.type === 'user';
}

function isClaudeStreamEventMessage(record: ClaudeObservationMessage): record is ClaudeStreamEventMessage {
  return record.type === 'stream_event';
}

function isClaudeSystemMessage(record: ClaudeObservationMessage): record is ClaudeSystemMessage {
  return record.type === 'system';
}

function claudeResultText(record: ClaudeResultMessage): string {
  return textValue(record.result) ?? textValue(record.response) ?? resultMarkerText(record);
}

export function claudeRecordEvents(
  id: string,
  record: ClaudeObservationMessage,
  recordIndex: number
): NativeCliObservationEvent[] {
  const base = recordIndex === 0 ? id : `${id}:json:${recordIndex}`;
  if (isClaudeResultMessage(record)) {
    return [
      ...observation({
        id: `${base}:result`,
        role: record.is_error ? 'system' : 'agent',
        text: claudeResultText(record),
        source: 'claude-code-sdk',
        providerEventType: 'result',
        raw: record
      }),
      ...permissionDenialEvents(
        id,
        record.permission_denials,
        'claude-code-sdk',
        recordIndex === 0 ? undefined : recordIndex
      )
    ];
  }
  if (isClaudeTranscriptMessage(record)) {
    const message = record.message;
    const content =
      message && typeof message === 'object' && !Array.isArray(message)
        ? (message as unknown as Record<string, unknown>).content
        : record.content;
    return contentEvents({
      id,
      content,
      recordIndex,
      source: 'claude-code-sdk',
      providerEventType: record.type,
      raw: record
    });
  }
  if (record.type === 'tool_result') {
    return observation({
      id: `${base}:tool-result`,
      role: 'tool',
      text: textValue(record.output, record.result, record.content) ?? JSON.stringify(record),
      source: 'claude-code-sdk',
      providerEventType: 'tool_result',
      raw: record
    });
  }
  if (isClaudeStreamEventMessage(record)) {
    const event = record.event;
    if (!event || typeof event !== 'object' || Array.isArray(event)) return [];
    const e = event as unknown as Record<string, unknown>;
    const delta = e.delta;
    if (e.type === 'content_block_delta' && delta && typeof delta === 'object' && !Array.isArray(delta)) {
      const d = delta as Record<string, unknown>;
      const text = rawTextValue(d.text, d.partial_json);
      const role = d.type === 'input_json_delta' || d.partial_json ? 'tool' : 'agent';
      return observation({
        id: `${id}:json:${recordIndex}:delta`,
        role,
        text,
        source: 'claude-code-sdk',
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
            source: 'claude-code-sdk',
            providerEventType: String(e.type),
            raw: record
          });
        }
      }
    }
  }
  if (isClaudeSystemMessage(record)) {
    return observation({
      id: `${id}:json:${recordIndex}:system`,
      role: 'system',
      text: textValue(record.subtype, record.error),
      source: 'claude-code-sdk',
      providerEventType: 'system',
      raw: record
    });
  }
  return [];
}
