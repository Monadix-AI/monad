import type { NativeCliObservationEvent, NativeCliUsageRecord } from '@monad/protocol';
import type {
  NativeCliObservationJsonRecordEntry,
  NativeCliObservationProjector,
  ObservationSource
} from '../observation-projection.ts';

import {
  commandText,
  compactJson,
  numberValue,
  observation,
  permissionDenialEvents,
  providerEpochMsTimestamp,
  providerEpochSecondsTimestamp,
  rawTextValue,
  recordValue,
  textValue,
  thinkingObservation
} from '../observation-projection.ts';

type CodexObservationResponseItem = Record<string, unknown> & { type: string };
export type CodexObservationNotification = Record<string, unknown> & { method: string };
type CodexMessageGroup = {
  key: string;
  kind: 'agent' | 'user';
  raw: Record<string, unknown>[];
  rawLines: string[];
  fragments: string[];
  startedText?: string;
  completedText?: string;
  startedAt?: string;
  completedAt?: string;
};

function isCodexObservationResponseItem(item: unknown): item is CodexObservationResponseItem {
  return (
    !!item && typeof item === 'object' && !Array.isArray(item) && typeof (item as { type?: unknown }).type === 'string'
  );
}

export function isCodexObservationNotification(
  record: Record<string, unknown>
): record is CodexObservationNotification {
  return typeof record.method === 'string';
}

function tokenUsageRow(id: string, tokens: unknown, contextWindow: unknown): NativeCliUsageRecord | undefined {
  const totalTokens = numberValue(tokens);
  const window = numberValue(contextWindow);
  if (totalTokens === undefined || window === undefined || window <= 0) return undefined;
  return {
    name: id,
    current: totalTokens,
    max: window
  };
}

function resetIso(value: unknown): string | undefined {
  const ms = numberValue(value);
  if (ms === undefined) return undefined;
  const timestampMs = ms < 10_000_000_000 ? ms * 1000 : ms;
  return new Date(timestampMs).toISOString();
}

function usageRecord(id: string, value: unknown): NativeCliUsageRecord | undefined {
  const record = recordValue(value);
  if (!record) return undefined;
  const used = numberValue(record.usedPercent, record.utilization, record.used_percent);
  if (used === undefined) return undefined;
  return {
    name: id,
    current: Math.max(0, Math.min(100, 100 - used)),
    max: 100,
    resetAt: resetIso(record.resetsAt ?? record.resets_at)
  };
}

export function codexUsageRecordsFromRecord(record: Record<string, unknown>): NativeCliUsageRecord[] {
  const method = textValue(record.method);
  if (method === 'thread/tokenUsage/updated') {
    const params = recordValue(record.params);
    const tokenUsage = recordValue(params?.tokenUsage);
    const last = recordValue(tokenUsage?.last);
    const total = recordValue(tokenUsage?.total);
    const contextWindow = tokenUsage?.modelContextWindow;
    return [
      tokenUsageRow('last_turn', last?.totalTokens, contextWindow),
      tokenUsageRow('thread_total', total?.totalTokens, contextWindow)
    ].filter((row): row is NativeCliUsageRecord => !!row);
  }
  if (method === 'account/rateLimits/updated') {
    const params = recordValue(record.params);
    const limits = recordValue(params?.rateLimits ?? params?.rate_limits);
    return limits
      ? Object.entries(limits)
          .map(([id, value]) => usageRecord(id, value))
          .filter((row): row is NativeCliUsageRecord => !!row)
      : [];
  }
  return [];
}

function codexItemText(item: Record<string, unknown> | undefined): string | undefined {
  if (!item) return undefined;
  const direct = rawTextValue(item.text);
  if (direct !== undefined) return direct;
  const content = item.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return [];
    const text = rawTextValue((part as Record<string, unknown>).text, (part as Record<string, unknown>).content);
    return text === undefined ? [] : [text];
  });
  return parts.length > 0 ? parts.join('') : undefined;
}

function codexMessageGroup(
  record: Record<string, unknown>
): { key: string; kind: CodexMessageGroup['kind'] } | undefined {
  const method = textValue(record.method);
  if (!method) return undefined;
  const params = recordValue(record.params);
  if (!params) return undefined;
  const item = recordValue(params.item);
  if (method === 'item/started' || method === 'item/completed') {
    const itemType = textValue(item?.type);
    const kind = itemType === 'agentMessage' ? 'agent' : itemType === 'userMessage' ? 'user' : undefined;
    if (!kind) return undefined;
    const itemId = textValue(item?.id);
    if (!itemId) return undefined;
    return { key: [textValue(params.threadId), textValue(params.turnId), itemId].filter(Boolean).join(':'), kind };
  }
  if (method === 'item/agentMessage/delta') {
    const itemId = textValue(params.itemId);
    if (!itemId) return undefined;
    return {
      key: [textValue(params.threadId), textValue(params.turnId), itemId].filter(Boolean).join(':'),
      kind: 'agent'
    };
  }
  return undefined;
}

function codexMessageLifecycleText(record: Record<string, unknown>): {
  completedAt?: string;
  completedText?: string;
  fragment?: string;
  startedAt?: string;
  startedText?: string;
} {
  const method = textValue(record.method);
  const params = recordValue(record.params);
  if (!method || !params) return {};
  if (method === 'item/agentMessage/delta') return { fragment: rawTextValue(params.delta, params.text) };
  const item = recordValue(params.item);
  const itemType = textValue(item?.type);
  if (itemType !== 'agentMessage' && itemType !== 'userMessage') return {};
  const text = codexItemText(item);
  if (method === 'item/started')
    return { startedAt: providerEpochMsTimestamp(numberValue(params.startedAtMs)), startedText: text };
  if (method === 'item/completed')
    return { completedAt: providerEpochMsTimestamp(numberValue(params.completedAtMs)), completedText: text };
  return {};
}

function codexMessageGroupInit(key: string, kind: CodexMessageGroup['kind']): CodexMessageGroup {
  return { key, kind, raw: [], rawLines: [], fragments: [] };
}

function codexMessageGroupAppend(group: CodexMessageGroup, entry: NativeCliObservationJsonRecordEntry): void {
  group.raw.push(entry.record);
  group.rawLines.push(entry.raw);
  const text = codexMessageLifecycleText(entry.record);
  if (text.fragment !== undefined) group.fragments.push(text.fragment);
  if (text.startedText !== undefined) group.startedText = text.startedText;
  if (text.completedText !== undefined) group.completedText = text.completedText;
  if (text.startedAt !== undefined) group.startedAt = text.startedAt;
  if (text.completedAt !== undefined) group.completedAt = text.completedAt;
}

function codexMessageGroupEvent(id: string, group: CodexMessageGroup): NativeCliObservationEvent[] {
  const text = group.completedText ?? group.startedText ?? group.fragments.join('');
  return observation({
    id: `${id}:json:${group.key}:${group.kind}-message`,
    role: group.kind,
    text,
    source: 'codex-app-server',
    providerEventType: group.kind === 'agent' ? 'item/agentMessage' : 'item/userMessage',
    createdAt: group.completedAt ?? group.startedAt,
    raw: group.rawLines.length > 1 ? group.rawLines : (group.raw[0] ?? group.rawLines[0])
  });
}

export const codexObservationMessageGroupAdapter = {
  append(group: unknown, entry: NativeCliObservationJsonRecordEntry): void {
    codexMessageGroupAppend(group as CodexMessageGroup, entry);
  },
  create(record: Record<string, unknown>): { key: string; state: CodexMessageGroup } | undefined {
    const group = codexMessageGroup(record);
    return group ? { key: group.key, state: codexMessageGroupInit(group.key, group.kind) } : undefined;
  },
  render(id: string, group: unknown): NativeCliObservationEvent[] {
    return codexMessageGroupEvent(id, group as CodexMessageGroup);
  }
};

function codexResponseMessageContentEvents(args: {
  id: string;
  content: unknown;
  recordIndex: number;
  source: ObservationSource;
  providerEventType: string;
  createdAt?: string;
  raw: unknown;
}): NativeCliObservationEvent[] {
  if (typeof args.content === 'string') {
    return observation({
      id: `${args.id}:json:${args.recordIndex}:message`,
      role: 'agent',
      text: args.content,
      source: args.source,
      providerEventType: args.providerEventType,
      createdAt: args.createdAt,
      raw: args.raw
    });
  }
  if (!Array.isArray(args.content)) return [];
  return args.content.flatMap((part, partIndex) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return [];
    const item = part as Record<string, unknown>;
    if (item.type === 'text' || item.type === 'output_text') {
      return observation({
        id: `${args.id}:json:${args.recordIndex}:message:${partIndex}`,
        role: 'agent',
        text: textValue(item.text, item.content),
        source: args.source,
        providerEventType: args.providerEventType,
        createdAt: args.createdAt,
        raw: args.raw
      });
    }
    if (item.type === 'reasoning' || item.type === 'thinking') {
      return thinkingObservation({
        id: `${args.id}:json:${args.recordIndex}:thinking:${partIndex}`,
        text: textValue(item.text, item.content, item.summary),
        source: args.source,
        providerEventType: String(item.type),
        createdAt: args.createdAt,
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
        source: args.source,
        providerEventType: args.providerEventType,
        createdAt: args.createdAt,
        raw: args.raw
      });
    }
    if (item.type === 'tool_result') {
      return observation({
        id: `${args.id}:json:${args.recordIndex}:tool-result:${partIndex}`,
        role: 'tool',
        text: textValue(item.content, item.output, item.result) ?? JSON.stringify(item.content ?? item),
        source: args.source,
        providerEventType: args.providerEventType,
        createdAt: args.createdAt,
        raw: args.raw
      });
    }
    return [];
  });
}

function codexResponseItem(
  id: string,
  item: CodexObservationResponseItem,
  recordIndex: number,
  source: ObservationSource,
  raw: unknown,
  createdAt?: string
): NativeCliObservationEvent[] {
  if (item.type === 'agent_message') {
    return observation({
      id: `${id}:json:${recordIndex}:agent-message`,
      role: 'agent',
      text: textValue(item.text),
      source,
      providerEventType: String(item.type),
      createdAt,
      raw
    });
  }
  if (item.type === 'reasoning' || item.type === 'thinking') {
    return thinkingObservation({
      id: `${id}:json:${recordIndex}:thinking`,
      text: textValue(item.text, item.content, item.summary),
      source,
      providerEventType: String(item.type),
      createdAt,
      raw
    });
  }
  if (item.type === 'message' && item.role === 'assistant') {
    return codexResponseMessageContentEvents({
      id,
      content: item.content,
      recordIndex,
      source,
      providerEventType: String(item.type),
      createdAt,
      raw
    });
  }
  if (item.type === 'function_call') {
    const tool = textValue(item.name) ?? 'tool';
    const args = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {});
    return observation({
      id: `${id}:json:${recordIndex}:function-call`,
      role: 'tool',
      text: `Tool call ${tool} ${args}`,
      source,
      providerEventType: String(item.type),
      createdAt,
      raw
    });
  }
  if (item.type === 'function_call_output') {
    return observation({
      id: `${id}:json:${recordIndex}:function-output`,
      role: 'tool',
      text: textValue(item.output) ?? JSON.stringify(item.output ?? item),
      source,
      providerEventType: String(item.type),
      createdAt,
      raw
    });
  }
  if (item.type === 'web_search_call') {
    return observation({
      id: `${id}:json:${recordIndex}:web-search`,
      role: 'tool',
      text: `Web search ${textValue(item.status) ?? ''}`.trim(),
      source,
      providerEventType: String(item.type),
      createdAt,
      raw
    });
  }
  return [];
}

function codexAppServerItemRecord(p: Record<string, unknown>): Record<string, unknown> | undefined {
  const item = p.item;
  if (item && typeof item === 'object' && !Array.isArray(item)) return item as Record<string, unknown>;
  return p;
}

function codexAppServerToolName(item: Record<string, unknown>, fallback = 'tool'): string {
  return textValue(item.name, item.tool, item.toolName, item.kind, item.type) ?? fallback;
}

function isCodexAppServerToolLikeItem(item: Record<string, unknown>): boolean {
  const type = textValue(item.type, item.kind, item.itemType);
  if (!type) return Boolean(item.command || item.name || item.tool || item.toolName || item.arguments || item.input);
  const normalizedType = type.toLowerCase();
  if (type === 'message' || type === 'agent_message' || type === 'reasoning') return false;
  return (
    normalizedType.includes('command') ||
    normalizedType.includes('exec') ||
    normalizedType.includes('tool') ||
    normalizedType.includes('mcp') ||
    normalizedType.includes('file') ||
    normalizedType.includes('function') ||
    normalizedType.includes('websearch') ||
    normalizedType.includes('web_search')
  );
}

function codexAppServerToolInput(item: Record<string, unknown>): unknown {
  return item.arguments ?? item.input ?? item.args ?? item.action ?? item.command ?? item.path ?? item.query;
}

function hasCodexAppServerToolInput(item: Record<string, unknown>): boolean {
  return (
    item.arguments !== undefined ||
    item.input !== undefined ||
    item.args !== undefined ||
    item.action !== undefined ||
    item.command !== undefined ||
    item.path !== undefined ||
    item.query !== undefined
  );
}

function hasCodexAppServerToolOutput(item: Record<string, unknown>): boolean {
  return (
    item.output !== undefined ||
    item.result !== undefined ||
    item.content !== undefined ||
    item.aggregatedOutput !== undefined ||
    item.error !== undefined
  );
}

function codexMcpContentText(value: unknown): string | undefined {
  const record = recordValue(value);
  if (!record || !Array.isArray(record.content)) return undefined;
  const parts = record.content.flatMap((part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return [];
    const text = rawTextValue((part as Record<string, unknown>).text, (part as Record<string, unknown>).content);
    return text === undefined ? [] : [text];
  });
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function codexAppServerToolCallObservation(args: {
  id: string;
  recordIndex: number;
  method: string;
  record: unknown;
  item: Record<string, unknown>;
  createdAt?: string;
}): NativeCliObservationEvent[] {
  const tool = codexAppServerToolName(args.item);
  const input = codexAppServerToolInput(args.item);
  const inputText = compactJson(input);
  return observation({
    id: `${args.id}:json:${args.recordIndex}:tool-call`,
    role: 'tool',
    text: `Tool call ${tool}${inputText ? ` ${inputText}` : ''}`,
    source: 'codex-app-server',
    providerEventType: 'function_call',
    createdAt: args.createdAt,
    raw: args.record
  });
}

function codexAppServerToolResultObservation(args: {
  id: string;
  recordIndex: number;
  itemIndex?: number;
  method: string;
  record: unknown;
  item: Record<string, unknown>;
  createdAt?: string;
}): NativeCliObservationEvent[] {
  const output =
    textValue(
      args.item.output,
      args.item.result,
      args.item.content,
      args.item.message,
      args.item.error,
      args.item.aggregatedOutput
    ) ??
    codexMcpContentText(args.item.result ?? args.item.output ?? args.item.content ?? args.item.aggregatedOutput) ??
    compactJson(args.item.output ?? args.item.result ?? args.item.content ?? args.item.aggregatedOutput ?? args.item);
  return observation({
    id: `${args.id}:json:${args.recordIndex}${args.itemIndex === undefined ? '' : `:${args.itemIndex}`}:tool-result`,
    role: 'tool',
    text: output,
    source: 'codex-app-server',
    providerEventType: 'function_call_output',
    createdAt: args.createdAt,
    raw: args.record
  });
}

function codexAppServerItemEvents(args: {
  id: string;
  record: unknown;
  item: Record<string, unknown>;
  itemIndex?: number;
  recordIndex: number;
}): NativeCliObservationEvent[] {
  const type = textValue(args.item.type);
  const itemIndex = args.itemIndex === undefined ? '' : `:${args.itemIndex}`;
  const createdAt = providerEpochMsTimestamp(
    numberValue(args.item.completedAtMs, args.item.startedAtMs, args.item.createdAtMs, args.item.updatedAtMs)
  );
  if (type === 'agentMessage' || type === 'userMessage') {
    return observation({
      id: `${args.id}:json:${args.recordIndex}${itemIndex}:${type}`,
      role: type === 'userMessage' ? 'user' : 'agent',
      text: codexItemText(args.item),
      source: 'codex-app-server',
      providerEventType: `item/${type}`,
      createdAt,
      raw: args.item
    });
  }
  if (type === 'contextCompaction') {
    return observation({
      id: `${args.id}:json:${args.recordIndex}${itemIndex}:context-compaction`,
      role: 'system',
      text: 'Context compacted',
      source: 'codex-app-server',
      providerEventType: 'contextCompaction',
      createdAt,
      raw: args.item
    });
  }
  if (isCodexObservationResponseItem(args.item)) {
    const responseItem = codexResponseItem(
      args.id,
      args.item,
      args.itemIndex ?? args.recordIndex,
      'codex-app-server',
      args.item,
      createdAt
    );
    if (responseItem.length > 0) return responseItem;
  }
  if (!isCodexAppServerToolLikeItem(args.item)) return [];
  const hasInput = hasCodexAppServerToolInput(args.item);
  const hasOutput = hasCodexAppServerToolOutput(args.item);
  if (hasOutput) {
    const result = codexAppServerToolResultObservation({
      id: args.id,
      recordIndex: args.recordIndex,
      itemIndex: args.itemIndex,
      method: 'item/completed',
      record: args.item,
      item: args.item,
      createdAt
    });
    return hasInput
      ? [
          ...codexAppServerToolCallObservation({
            id: args.id,
            recordIndex: args.recordIndex,
            method: 'item/completed',
            record: args.item,
            item: args.item,
            createdAt
          }),
          ...result
        ]
      : result;
  }
  return codexAppServerToolCallObservation({
    id: args.id,
    recordIndex: args.recordIndex,
    method: 'item/started',
    record: args.item,
    item: args.item,
    createdAt
  });
}

export function codexAppServerBatchRecordEvents(
  id: string,
  record: Record<string, unknown>,
  recordIndex: number
): NativeCliObservationEvent[] {
  if (!Array.isArray(record.items)) return [];
  return record.items.flatMap((item, itemIndex) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    return codexAppServerItemEvents({
      id,
      record,
      item: item as Record<string, unknown>,
      itemIndex,
      recordIndex
    });
  });
}

export function codexAppServerTurnsPageRecordEvents(
  id: string,
  record: Record<string, unknown>,
  recordIndex: number
): NativeCliObservationEvent[] {
  const result = recordValue(record.result);
  if (!result || !Array.isArray(result.data)) return [];
  let itemOffset = 0;
  return result.data.flatMap((turn) => {
    if (!turn || typeof turn !== 'object' || Array.isArray(turn)) return [];
    const items = (turn as Record<string, unknown>).items;
    if (!Array.isArray(items)) return [];
    return items.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const currentItemIndex = itemOffset;
      itemOffset += 1;
      return codexAppServerItemEvents({
        id,
        record,
        item: item as Record<string, unknown>,
        itemIndex: currentItemIndex,
        recordIndex
      });
    });
  });
}

export function codexExecRecordEvents(
  id: string,
  record: Record<string, unknown>,
  recordIndex: number
): NativeCliObservationEvent[] {
  const type = record.type;
  const base = recordIndex === 0 ? id : `${id}:json:${recordIndex}`;
  if (type === 'result') {
    return [
      ...observation({
        id: `${base}:result`,
        role: 'agent',
        text: textValue(record.result, record.response, record.text),
        source: 'codex-exec',
        providerEventType: 'result',
        raw: record
      }),
      ...permissionDenialEvents(
        id,
        record.permission_denials,
        'codex-exec',
        recordIndex === 0 ? undefined : recordIndex
      )
    ];
  }
  if (type === 'item.completed' || type === 'item.started') {
    const item = record.item;
    if (isCodexObservationResponseItem(item)) {
      return codexResponseItem(id, item, recordIndex, 'codex-exec', record);
    }
  }
  if (type === 'event_msg') {
    const payload = record.payload;
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const p = payload as Record<string, unknown>;
      const text = p.type === 'agent_message' ? textValue(p.message) : undefined;
      return observation({
        id: `${id}:json:${recordIndex}:event-message`,
        role: 'agent',
        text,
        source: 'codex-exec',
        providerEventType: 'event_msg',
        raw: record
      });
    }
  }
  if (type === 'response_item') {
    const payload = record.payload;
    if (isCodexObservationResponseItem(payload)) {
      return codexResponseItem(id, payload, recordIndex, 'codex-exec', record);
    }
  }
  return [];
}

export function codexAppServerRecordEvents(
  id: string,
  record: CodexObservationNotification,
  recordIndex: number
): NativeCliObservationEvent[] {
  const method = record.method;
  if (!method) return [];
  const params =
    record.params && typeof record.params === 'object' && !Array.isArray(record.params) ? record.params : {};
  const p = params as Record<string, unknown>;
  if (method === 'thread/started') {
    const thread = p.thread && typeof p.thread === 'object' && !Array.isArray(p.thread) ? p.thread : {};
    const cwd = textValue((thread as Record<string, unknown>).cwd);
    return observation({
      id: `${id}:json:${recordIndex}:thread-started`,
      role: 'system',
      text: cwd ? `Thread started in ${cwd}` : 'Thread started',
      source: 'codex-app-server',
      providerEventType: method,
      raw: record
    });
  }
  if (method === 'mcpServer/startupStatus/updated') {
    const name = textValue(p.name) ?? 'MCP server';
    const status = textValue(p.status) ?? 'updated';
    const error = textValue(p.error);
    return observation({
      id: `${id}:json:${recordIndex}:mcp-status`,
      role: error ? 'system' : 'tool',
      text: error ? `${name} ${status}: ${error}` : `${name} ${status}`,
      source: 'codex-app-server',
      providerEventType: method,
      raw: record
    });
  }
  if (method === 'rawResponseItem/completed') {
    const item = p.item;
    return isCodexObservationResponseItem(item)
      ? codexResponseItem(id, item, recordIndex, 'codex-app-server', record)
      : [];
  }
  if (method === 'account/rateLimits/updated') {
    return observation({
      id: `${id}:json:${recordIndex}:rate-limits`,
      role: 'system',
      text: 'Usage limits updated',
      source: 'codex-app-server',
      providerEventType: method,
      raw: record
    });
  }
  if (method === 'thread/tokenUsage/updated') {
    return observation({
      id: `${id}:json:${recordIndex}:token-usage`,
      role: 'system',
      text: 'Token usage updated',
      source: 'codex-app-server',
      providerEventType: method,
      raw: record
    });
  }
  if (method === 'item/started') {
    const item = codexAppServerItemRecord(p);
    if (!item) return [];
    if (!isCodexAppServerToolLikeItem(item)) return [];
    return codexAppServerToolCallObservation({
      id,
      recordIndex,
      method,
      record,
      item,
      createdAt: providerEpochMsTimestamp(numberValue(p.startedAtMs))
    });
  }
  if (method === 'item/completed') {
    const item = codexAppServerItemRecord(p);
    if (!item) return [];
    const createdAt = providerEpochMsTimestamp(numberValue(p.completedAtMs));
    const itemType = textValue(item.type);
    if (itemType === 'contextCompaction') {
      return observation({
        id: `${id}:json:${recordIndex}:context-compaction`,
        role: 'system',
        text: 'Context compacted',
        source: 'codex-app-server',
        providerEventType: 'contextCompaction',
        createdAt,
        raw: record
      });
    }
    if (isCodexObservationResponseItem(item)) {
      const responseItem = codexResponseItem(id, item, recordIndex, 'codex-app-server', record, createdAt);
      if (responseItem.length > 0) return responseItem;
    }
    if (!isCodexAppServerToolLikeItem(item)) return [];
    if (!hasCodexAppServerToolOutput(item)) {
      return codexAppServerToolCallObservation({ id, recordIndex, method, record, item, createdAt });
    }
    const result = codexAppServerToolResultObservation({ id, recordIndex, method, record, item, createdAt });
    return hasCodexAppServerToolInput(item)
      ? [...codexAppServerToolCallObservation({ id, recordIndex, method, record, item, createdAt }), ...result]
      : result;
  }
  if (
    method === 'item/commandExecution/outputDelta' ||
    method === 'command/exec/outputDelta' ||
    method === 'process/outputDelta' ||
    method === 'item/fileChange/outputDelta' ||
    method === 'item/mcpToolCall/progress'
  ) {
    return observation({
      id: `${id}:json:${recordIndex}:tool-delta`,
      role: 'tool',
      text: rawTextValue(p.delta, p.output, p.text, p.message),
      source: 'codex-app-server',
      providerEventType: method,
      raw: record,
      preserveWhitespace: true
    });
  }
  if (method === 'item/agentMessage/delta') {
    return observation({
      id: `${id}:json:${recordIndex}:agent-delta`,
      role: 'agent',
      text: rawTextValue(p.delta, p.text),
      source: 'codex-app-server',
      providerEventType: method,
      raw: record,
      preserveWhitespace: true
    });
  }
  if (
    method === 'item/reasoning/summaryTextDelta' ||
    method === 'item/reasoning/textDelta' ||
    method === 'item/plan/delta'
  ) {
    return thinkingObservation({
      id: `${id}:json:${recordIndex}:reasoning-delta`,
      text: rawTextValue(p.delta, p.text),
      source: 'codex-app-server',
      providerEventType: method,
      raw: record,
      preserveWhitespace: true
    });
  }
  if (method === 'turn/diff/updated') {
    return observation({
      id: `${id}:json:${recordIndex}:diff`,
      role: 'tool',
      text: rawTextValue(p.diff, p.unifiedDiff),
      source: 'codex-app-server',
      providerEventType: method,
      raw: record,
      preserveWhitespace: true
    });
  }
  if (method === 'turn/started' || method === 'turn/completed' || method === 'thread/status/changed') {
    const turn = recordValue(p.turn);
    const createdAt =
      method === 'turn/started'
        ? providerEpochSecondsTimestamp(numberValue(turn?.startedAt))
        : method === 'turn/completed'
          ? providerEpochSecondsTimestamp(numberValue(turn?.completedAt))
          : undefined;
    return observation({
      id: `${id}:json:${recordIndex}:status`,
      role: 'system',
      text: textValue(p.status, p.type) ?? method,
      source: 'codex-app-server',
      providerEventType: method,
      createdAt,
      raw: record
    });
  }
  if (method.includes('Approval') || method.includes('approval')) {
    const command = commandText(p.command);
    const reason = textValue(p.reason);
    return observation({
      id: `${id}:json:${recordIndex}:approval`,
      role: 'tool',
      text: `Approval requested: ${command ?? reason ?? method}`,
      source: 'codex-app-server',
      providerEventType: method,
      raw: record
    });
  }
  return [];
}

export const codexObservationProjection = {
  usageRecords: codexUsageRecordsFromRecord,
  messageGroup: codexObservationMessageGroupAdapter,
  recordProjectors: [
    {
      supports: isCodexObservationNotification,
      parse: ({ id, record, recordIndex }) =>
        isCodexObservationNotification(record) ? codexAppServerRecordEvents(id, record, recordIndex) : []
    },
    { parse: ({ id, record, recordIndex }) => codexAppServerBatchRecordEvents(id, record, recordIndex) },
    { parse: ({ id, record, recordIndex }) => codexAppServerTurnsPageRecordEvents(id, record, recordIndex) },
    { parse: ({ id, record, recordIndex }) => codexExecRecordEvents(id, record, recordIndex) }
  ]
} satisfies NativeCliObservationProjector;
