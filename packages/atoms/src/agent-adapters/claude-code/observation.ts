import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk';
import type { MeshAgentObservationEvent, MeshAgentUsageRecord } from '@monad/protocol';
import type { MeshAgentObservationProjector, ObservationRole } from '../observation-projection.ts';

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

export function claudeUsageRecordsFromRecord(record: Record<string, unknown>): MeshAgentUsageRecord[] {
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
  return textValue(record.result, record.response) ?? resultMarkerText(record);
}

function claudeContentHasText(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some(
    (part) =>
      part !== null &&
      typeof part === 'object' &&
      !Array.isArray(part) &&
      (part as Record<string, unknown>).type === 'text' &&
      textValue((part as Record<string, unknown>).text) !== undefined
  );
}

function claudeContentEvents(args: {
  id: string;
  content: unknown;
  recordIndex: number;
  indexedId: boolean;
  providerEventType: string;
  createdAt?: string;
  raw: unknown;
  textRole: Extract<ObservationRole, 'agent' | 'user'>;
}): MeshAgentObservationEvent[] {
  if (typeof args.content === 'string') {
    return observation({
      id: claudeProjectionId(args.id, args.recordIndex, 'message', args.indexedId),
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
        id: claudeProjectionId(args.id, args.recordIndex, `message:${partIndex}`, args.indexedId),
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
        id: claudeProjectionId(args.id, args.recordIndex, `thinking:${partIndex}`, args.indexedId),
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
        id: claudeProjectionId(args.id, args.recordIndex, `tool:${partIndex}`, args.indexedId),
        role: 'tool',
        text: `Tool call ${tool}${inputText}`,
        source: 'claude-code-sdk',
        providerEventType: 'tool_use',
        createdAt: args.createdAt,
        raw: args.raw
      });
    }
    if (item.type === 'tool_result') {
      return observation({
        id: claudeProjectionId(args.id, args.recordIndex, `tool-result:${partIndex}`, args.indexedId),
        role: 'tool',
        text: textValue(item.content) ?? JSON.stringify(item.content ?? item),
        source: 'claude-code-sdk',
        providerEventType: 'tool_result',
        createdAt: args.createdAt,
        raw: args.raw
      });
    }
    return [];
  });
}

function claudeRecordBaseId(fallbackId: string, record: ClaudeObservationMessage): string {
  return textValue(record.uuid) ?? fallbackId;
}

function claudeProjectionId(base: string, recordIndex: number, part: string, indexedId: boolean): string {
  return indexedId ? `${base}:json:${recordIndex}:${part}` : `${base}:${part}`;
}

function claudeTopLevelProjectionId(base: string, recordIndex: number, part: string, indexedId: boolean): string {
  return indexedId && recordIndex > 0 ? `${base}:json:${recordIndex}:${part}` : `${base}:${part}`;
}

export function claudeRecordEvents(
  id: string,
  record: ClaudeObservationMessage,
  recordIndex: number
): MeshAgentObservationEvent[] {
  const base = claudeRecordBaseId(id, record);
  const indexedId = textValue(record.uuid) === undefined;
  if (record.type === 'rate_limit_event') {
    return observation({
      id: claudeTopLevelProjectionId(base, recordIndex, 'rate-limit', indexedId),
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
        id: claudeTopLevelProjectionId(base, recordIndex, 'result', indexedId),
        role: record.is_error ? 'system' : 'agent',
        text: claudeResultText(record),
        source: 'claude-code-sdk',
        providerEventType: record.is_error && subtype ? subtype : 'result',
        raw: record
      }),
      ...permissionDenialEvents(
        base,
        record.permission_denials,
        'claude-code-sdk',
        indexedId && recordIndex > 0 ? recordIndex : undefined
      )
    ];
  }
  if (isClaudeTranscriptMessage(record)) {
    const message = record.message;
    const messageRecord =
      message && typeof message === 'object' && !Array.isArray(message)
        ? (message as unknown as Record<string, unknown>)
        : undefined;
    const content = messageRecord?.content ?? record.content;
    const createdAt = providerIsoTimestamp(textValue(record.timestamp));
    const contentEvents = claudeContentEvents({
      id: base,
      content,
      recordIndex,
      indexedId,
      providerEventType: record.type,
      createdAt,
      raw: record,
      textRole: record.type === 'user' ? 'user' : 'agent'
    });
    const startsTurn = record.type === 'user' && claudeContentHasText(content);
    const stopReason = textValue(messageRecord?.stop_reason, record.stop_reason);
    const isHistoryTranscript = textValue(record.uuid) !== undefined && textValue(record.session_id) === undefined;
    const endsTurn =
      isHistoryTranscript &&
      record.type === 'assistant' &&
      claudeContentHasText(content) &&
      (stopReason === 'end_turn' || stopReason === 'stop_sequence');
    return [
      ...(startsTurn
        ? observation({
            id: claudeProjectionId(base, recordIndex, 'turn-start', indexedId),
            role: 'system',
            text: 'Turn started',
            source: 'claude-code-sdk',
            providerEventType: 'turn-start',
            createdAt,
            raw: record
          })
        : []),
      ...contentEvents,
      ...(endsTurn
        ? observation({
            id: claudeProjectionId(base, recordIndex, 'turn-end', indexedId),
            role: 'system',
            text: 'Turn completed',
            source: 'claude-code-sdk',
            providerEventType: 'turn-end',
            createdAt,
            raw: record
          })
        : [])
    ];
  }
  // The adapter emits `{ type: 'tool_result', ... }` records at runtime (see index.ts), but that
  // variant isn't in the SDKMessage `type` union, so read through the loose Record view rather than
  // the narrowed (here: `never`) discriminant.
  const loose = record as Record<string, unknown>;
  if (loose.type === 'tool_result') {
    return observation({
      id: claudeTopLevelProjectionId(base, recordIndex, 'tool-result', indexedId),
      role: 'tool',
      text: textValue(loose.output, loose.result, loose.content) ?? JSON.stringify(record),
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
          id: claudeProjectionId(base, recordIndex, 'thinking-delta', indexedId),
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
        id: claudeProjectionId(base, recordIndex, 'delta', indexedId),
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
            id: claudeProjectionId(base, recordIndex, 'tool-start', indexedId),
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
    if (loose.subtype === 'thinking_tokens') {
      const estimatedTokens = numberValue(loose.estimated_tokens);
      if (estimatedTokens !== undefined) {
        return thinkingObservation({
          id: `${base}:thinking-tokens`,
          text: `Thinking… · ${Math.trunc(estimatedTokens)} tokens`,
          source: 'claude-code-sdk',
          providerEventType: 'thinking_tokens_delta',
          raw: record
        });
      }
    }
    return observation({
      id: claudeProjectionId(base, recordIndex, 'system', indexedId),
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
  checkpoint: (event: MeshAgentObservationEvent) => textValue(recordValue(event.provenance.rawEvents[0])?.uuid),
  identity: (event: MeshAgentObservationEvent) => textValue(recordValue(event.provenance.rawEvents[0])?.uuid),
  usageRecords: claudeUsageRecordsFromRecord,
  classifyActivity: classifyObservationActivity,
  isStreamingFragment: isStreamingObservationFragment,
  mergeStreamingRun: (events: MeshAgentObservationEvent[]) => {
    const first = events[0];
    const latest = events.at(-1);
    if (!first || !latest || first.providerEventType !== 'thinking_tokens_delta') return undefined;
    return {
      ...latest,
      id: first.id,
      provenance: { rawEvents: events.flatMap((event) => event.provenance.rawEvents) }
    };
  },
  recordProjectors: [
    {
      supports: isClaudeObservationMessage,
      parse: ({ id, record, recordIndex }) =>
        isClaudeObservationMessage(record) ? claudeRecordEvents(id, record, recordIndex) : []
    }
  ]
} satisfies MeshAgentObservationProjector;
