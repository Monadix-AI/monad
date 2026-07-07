import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk';
import type { NativeCliObservationEvent, NativeCliUsageRecord } from '@monad/protocol';
import type { NativeCliObservationProjector, ObservationRole } from '../observation-projection.ts';

import {
  classifyObservationActivity,
  isStreamingObservationFragment,
  numberValue,
  observation,
  permissionDenialEvents,
  providerIsoTimestamp,
  rawTextValue,
  recordValue,
  resultMarkerText,
  textValue,
  thinkingObservation
} from '../observation-projection.ts';

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

function resetIso(value: unknown): string | undefined {
  const ms = numberValue(value);
  if (ms === undefined) return undefined;
  const timestampMs = ms < 10_000_000_000 ? ms * 1000 : ms;
  return new Date(timestampMs).toISOString();
}

export function claudeUsageRecordsFromRecord(record: Record<string, unknown>): NativeCliUsageRecord[] {
  if (record.type !== 'rate_limit_event') return [];
  const info = recordValue(record.rate_limit_info ?? record.rateLimitInfo);
  const id = textValue(info?.rateLimitType, info?.rate_limit_type);
  if (!info || !id) return [];
  const used = numberValue(info.usedPercent, info.utilization, info.used_percent);
  const status = textValue(info.status);
  if (used === undefined && !status) return [];
  return [
    {
      name: id,
      current: used === undefined ? (status === 'allowed' ? 100 : 0) : Math.max(0, Math.min(100, 100 - used)),
      max: 100,
      resetAt: resetIso(info.resetsAt ?? info.resets_at)
    }
  ];
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

function claudeContentEvents(args: {
  id: string;
  content: unknown;
  recordIndex: number;
  providerEventType: string;
  createdAt?: string;
  raw: unknown;
  textRole: Extract<ObservationRole, 'agent' | 'user'>;
}): NativeCliObservationEvent[] {
  if (typeof args.content === 'string') {
    return observation({
      id: `${args.id}:json:${args.recordIndex}:message`,
      role: args.textRole,
      text: args.content,
      source: 'claude-code-sdk',
      providerEventType: args.providerEventType,
      createdAt: args.createdAt,
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
        text: textValue(item.text),
        source: 'claude-code-sdk',
        providerEventType: args.providerEventType,
        createdAt: args.createdAt,
        raw: args.raw
      });
    }
    if (item.type === 'thinking' || item.type === 'reasoning') {
      return thinkingObservation({
        id: `${args.id}:json:${args.recordIndex}:thinking:${partIndex}`,
        text: textValue(item.thinking, item.text, item.content),
        source: 'claude-code-sdk',
        providerEventType: String(item.type),
        createdAt: args.createdAt,
        raw: args.raw
      });
    }
    if (item.type === 'tool_use') {
      const tool = textValue(item.name) ?? 'tool';
      const input = item.input;
      const inputText = input === undefined ? '' : ` ${typeof input === 'string' ? input : JSON.stringify(input)}`;
      return observation({
        id: `${args.id}:json:${args.recordIndex}:tool:${partIndex}`,
        role: 'tool',
        text: `Tool call ${tool}${inputText}`,
        source: 'claude-code-sdk',
        providerEventType: args.providerEventType,
        createdAt: args.createdAt,
        raw: args.raw
      });
    }
    if (item.type === 'tool_result') {
      return observation({
        id: `${args.id}:json:${args.recordIndex}:tool-result:${partIndex}`,
        role: 'tool',
        text: textValue(item.content) ?? JSON.stringify(item.content ?? item),
        source: 'claude-code-sdk',
        providerEventType: args.providerEventType,
        createdAt: args.createdAt,
        raw: args.raw
      });
    }
    return [];
  });
}

export function claudeRecordEvents(
  id: string,
  record: ClaudeObservationMessage,
  recordIndex: number
): NativeCliObservationEvent[] {
  const base = recordIndex === 0 ? id : `${id}:json:${recordIndex}`;
  if (record.type === 'rate_limit_event') {
    return observation({
      id: `${base}:rate-limit`,
      role: 'system',
      text: 'Usage limits updated',
      source: 'claude-code-sdk',
      providerEventType: 'rate_limit_event',
      raw: record
    });
  }
  if (isClaudeResultMessage(record)) {
    const subtype = textValue(record.subtype);
    return [
      ...observation({
        id: `${base}:result`,
        role: record.is_error ? 'system' : 'agent',
        text: claudeResultText(record),
        source: 'claude-code-sdk',
        providerEventType: record.is_error && subtype ? subtype : 'result',
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
    const createdAt = record.type === 'user' ? providerIsoTimestamp(textValue(record.timestamp)) : undefined;
    return claudeContentEvents({
      id,
      content,
      recordIndex,
      providerEventType: record.type,
      createdAt,
      raw: record,
      textRole: record.type === 'user' ? 'user' : 'agent'
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
      if (d.type === 'thinking_delta' || d.thinking !== undefined) {
        return thinkingObservation({
          id: `${id}:json:${recordIndex}:thinking-delta`,
          text: rawTextValue(d.thinking, d.text),
          source: 'claude-code-sdk',
          providerEventType: 'thinking_delta',
          raw: record,
          preserveWhitespace: true
        });
      }
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

export const claudeCodeObservationProjection = {
  usageRecords: claudeUsageRecordsFromRecord,
  classifyActivity: classifyObservationActivity,
  isStreamingFragment: isStreamingObservationFragment,
  recordProjectors: [
    {
      supports: isClaudeObservationMessage,
      parse: ({ id, record, recordIndex }) =>
        isClaudeObservationMessage(record) ? claudeRecordEvents(id, record, recordIndex) : []
    }
  ]
} satisfies NativeCliObservationProjector;
