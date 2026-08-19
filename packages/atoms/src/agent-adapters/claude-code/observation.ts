import type {
  SDKAssistantMessage,
  SDKCompactBoundaryMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk';
import type { MeshAgentObservationEvent, MeshAgentUsageRecord } from '@monad/protocol';
import type { MeshAgentObservationProjector, ObservationRole } from '../shared/observation/observation-projection.ts';

import { z } from 'zod';

import { claudeCodeTranscriptTool } from './tool-fields.ts';

const looseRecordSchema = z.record(z.string(), z.unknown());

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
  thinkingObservation,
  toolCategoryByName,
  turnEndReasonFromStopValue
} from '../shared/observation/observation-projection.ts';
import { reconcileClaudeStreamEvents } from './observation-stream.ts';
import { claudeCodeToolRuns } from './tool-runs.ts';

export type ClaudeObservationMessage = Partial<SDKMessage> & Record<string, unknown> & { type: string };
type ClaudeTranscriptMessage = Partial<SDKAssistantMessage | SDKUserMessage> &
  Record<string, unknown> & { type: 'assistant' | 'user' };
type ClaudeResultMessage = Partial<SDKResultMessage> & Record<string, unknown> & { type: 'result' };
type ClaudeStreamEventMessage = Partial<SDKPartialAssistantMessage> &
  Record<string, unknown> & { type: 'stream_event' };
type ClaudeSystemMessage = Partial<SDKSystemMessage | SDKCompactBoundaryMessage> &
  Record<string, unknown> & { type: 'system' };

export function isClaudeObservationMessage(record: Record<string, unknown>): record is ClaudeObservationMessage {
  return (
    record.type === 'assistant' ||
    record.type === 'user' ||
    record.type === 'result' ||
    record.type === 'stream_event' ||
    record.type === 'system' ||
    record.type === 'rate_limit_event' ||
    record.type === 'tool_result'
  );
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
      const text = textValue(item.thinking, item.text, item.content);
      if (!text) return [];
      return thinkingObservation({
        id: claudeProjectionId(args.id, args.recordIndex, `thinking:${partIndex}`, args.indexedId),
        text,
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
        tool: {
          name: tool,
          ...(textValue(item.id) ? { callId: textValue(item.id) } : {}),
          ...(input === undefined ? {} : { input })
        },
        raw: args.raw
      });
    }
    if (item.type === 'tool_result') {
      return observation({
        id: claudeProjectionId(args.id, args.recordIndex, `tool-result:${partIndex}`, args.indexedId),
        role: 'tool',
        text: rawTextValue(item.content) ?? JSON.stringify(item.content ?? item),
        source: 'claude-code-sdk',
        providerEventType: 'tool_result',
        createdAt: args.createdAt,
        tool: {
          ...(textValue(item.tool_use_id) ? { callId: textValue(item.tool_use_id) } : {}),
          status: item.is_error === true ? 'failed' : 'completed'
        },
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

function claudeToolCallId(event: MeshAgentObservationEvent): string | undefined {
  if (event.role !== 'tool') return undefined;
  const partIndexMatch = /:(?:tool|tool-result):(\d+)$/.exec(event.id);
  const partIndex = partIndexMatch ? Number(partIndexMatch[1]) : undefined;
  for (const rawEvent of event.provenance.rawEvents) {
    const raw = recordValue(rawEvent);
    const payload = recordValue(raw?.payload);
    const direct = textValue(raw?.tool_use_id, raw?.toolUseId, raw?.callId, payload?.callId);
    if (direct) return direct;
    const nativeBlock = recordValue(recordValue(raw?.event)?.content_block);
    const nativeId = nativeBlock?.type === 'tool_use' ? textValue(nativeBlock.id) : undefined;
    if (nativeId) return nativeId;
    const message = recordValue(raw?.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    const indexedPart = partIndex === undefined ? undefined : recordValue(content[partIndex]);
    const indexedId = textValue(
      indexedPart?.type === 'tool_use' ? indexedPart.id : undefined,
      indexedPart?.type === 'tool_result' ? indexedPart.tool_use_id : undefined
    );
    if (indexedId) return indexedId;
    const ids = content.flatMap((part) => {
      const item = recordValue(part);
      const id = textValue(
        item?.type === 'tool_use' ? item.id : undefined,
        item?.type === 'tool_result' ? item.tool_use_id : undefined
      );
      return id ? [id] : [];
    });
    if (ids.length === 1) return ids[0];
  }
  return undefined;
}

function claudeObservationDedupeIdentity(event: MeshAgentObservationEvent): string | undefined {
  const callId = claudeToolCallId(event);
  return callId ? `tool:${callId}` : undefined;
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
        turnEndReason: record.is_error ? 'error' : turnEndReasonFromStopValue(subtype),
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
      message && typeof message === 'object' && !Array.isArray(message) ? looseRecordSchema.parse(message) : undefined;
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
            turnEndReason: turnEndReasonFromStopValue(recordValue(record.message)?.stop_reason),
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
      text: rawTextValue(loose.output, loose.result, loose.content) ?? JSON.stringify(record),
      source: 'claude-code-sdk',
      providerEventType: 'tool_result',
      tool: {
        ...(textValue(loose.name, loose.tool) ? { name: textValue(loose.name, loose.tool) } : {}),
        ...(textValue(loose.tool_use_id, loose.id) ? { callId: textValue(loose.tool_use_id, loose.id) } : {}),
        ...((loose.output ?? loose.result ?? loose.content) === undefined
          ? {}
          : { output: loose.output ?? loose.result ?? loose.content }),
        status: loose.is_error === true ? 'failed' : 'completed'
      },
      raw: record
    });
  }
  if (isClaudeStreamEventMessage(record)) {
    const event = record.event;
    if (!event || typeof event !== 'object' || Array.isArray(event)) return [];
    const e = looseRecordSchema.parse(event);
    const delta = e.delta;
    if (e.type === 'content_block_delta' && delta && typeof delta === 'object' && !Array.isArray(delta)) {
      const d = delta as Record<string, unknown>;
      if (d.type === 'thinking_delta' || d.thinking !== undefined) {
        const text = rawTextValue(d.thinking, d.text);
        if (text === undefined || text.length === 0) return [];
        return thinkingObservation({
          id: claudeProjectionId(base, recordIndex, 'thinking-delta', indexedId),
          text,
          source: 'claude-code-sdk',
          providerEventType: 'thinking_delta',
          raw: record,
          preserveWhitespace: true
        });
      }
      if (d.type === 'input_json_delta' || d.partial_json !== undefined) {
        return observation({
          id: claudeProjectionId(base, recordIndex, 'stream-boundary', indexedId),
          role: 'system',
          text: String(e.type),
          source: 'claude-code-sdk',
          providerEventType: `stream/${String(e.type)}`,
          raw: record
        });
      }
      const text = rawTextValue(d.text);
      return observation({
        id: claudeProjectionId(base, recordIndex, 'delta', indexedId),
        role: 'agent',
        text,
        source: 'claude-code-sdk',
        providerEventType: String(e.type),
        raw: record,
        preserveWhitespace: true
      });
    }
    return observation({
      id: claudeProjectionId(base, recordIndex, 'stream-boundary', indexedId),
      role: 'system',
      text: String(e.type),
      source: 'claude-code-sdk',
      providerEventType: `stream/${String(e.type)}`,
      raw: record
    });
  }
  if (isClaudeSystemMessage(record)) {
    if (loose.subtype === 'init' && Array.isArray(loose.mcp_servers) && loose.mcp_servers.length > 0) {
      const servers = loose.mcp_servers.flatMap((value) => {
        const server = recordValue(value);
        const name = textValue(server?.name);
        return name ? [{ name, status: textValue(server?.status) ?? 'updated' }] : [];
      });
      return observation({
        id: claudeProjectionId(base, recordIndex, 'mcp-startup', indexedId),
        projection: 'unknown',
        role: 'system',
        text: 'MCP servers initialized',
        source: 'claude-code-sdk',
        providerEventType: 'mcp_servers_initialized',
        ...(servers.length > 0
          ? {
              progress: {
                kind: 'mcp-startup' as const,
                servers: servers as [(typeof servers)[number], ...(typeof servers)[number][]],
                snapshot: true
              }
            }
          : {}),
        raw: record
      });
    }
    if (loose.subtype === 'compact_boundary') {
      return observation({
        id: claudeProjectionId(base, recordIndex, 'context-compaction', indexedId),
        role: 'system',
        text: 'Context compacted',
        source: 'claude-code-sdk',
        providerEventType: 'compact_boundary',
        raw: record
      });
    }
    if (loose.subtype === 'thinking_tokens') {
      const estimatedTokens = numberValue(loose.estimated_tokens);
      if (estimatedTokens !== undefined) {
        return thinkingObservation({
          id: `${base}:thinking-tokens`,
          text: `Thinking… ${Math.trunc(estimatedTokens)} tokens`,
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
  dedupeIdentity: claudeObservationDedupeIdentity,
  identity: (event: MeshAgentObservationEvent) => textValue(recordValue(event.provenance.rawEvents[0])?.uuid),
  usageRecords: claudeUsageRecordsFromRecord,
  classifyActivity: classifyObservationActivity,
  toolCategory: toolCategoryByName('shell', ['Bash']),
  toolFields: claudeCodeTranscriptTool,
  toolRuns: claudeCodeToolRuns,
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
  reconcileEvents: reconcileClaudeStreamEvents,
  recordProjectors: [
    {
      supports: isClaudeObservationMessage,
      parse: ({ id, record, recordIndex }) =>
        isClaudeObservationMessage(record) ? claudeRecordEvents(id, record, recordIndex) : []
    }
  ]
} satisfies MeshAgentObservationProjector;
