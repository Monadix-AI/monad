import type {
  CodexAppServerNotification,
  CodexAppServerResponseItem,
  CodexAppServerServerRequest,
  NativeCliObservationEvent
} from '@monad/protocol';
import type { ObservationSource } from './native-cli-observation-shared.ts';

import { isCodexAppServerObservationMethod } from '@monad/protocol';

import {
  commandText,
  compactJson,
  contentEvents,
  observation,
  permissionDenialEvents,
  rawTextValue,
  textValue
} from './native-cli-observation-shared.ts';

type CodexObservationResponseItem = Partial<CodexAppServerResponseItem> & Record<string, unknown> & { type: string };
export type CodexObservationNotification = Partial<CodexAppServerNotification | CodexAppServerServerRequest> &
  Record<string, unknown> & { method: string };

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

function codexResponseItem(
  id: string,
  item: CodexObservationResponseItem,
  recordIndex: number,
  source: ObservationSource,
  raw: unknown
): NativeCliObservationEvent[] {
  if (item.type === 'agent_message') {
    return observation({
      id: `${id}:json:${recordIndex}:agent-message`,
      role: 'agent',
      text: textValue(item.text),
      source,
      providerEventType: String(item.type),
      raw
    });
  }
  if (item.type === 'message' && item.role === 'assistant') {
    return contentEvents({
      id,
      content: item.content,
      recordIndex,
      source,
      providerEventType: String(item.type),
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
  if (type === 'message' || type === 'agent_message' || type === 'reasoning') return false;
  return (
    type.includes('command') ||
    type.includes('exec') ||
    type.includes('tool') ||
    type.includes('mcp') ||
    type.includes('file') ||
    type.includes('function') ||
    type.includes('web_search')
  );
}

function codexAppServerToolInput(item: Record<string, unknown>): unknown {
  return item.arguments ?? item.input ?? item.args ?? item.command ?? item.path ?? item.query;
}

function codexAppServerToolCallObservation(args: {
  id: string;
  recordIndex: number;
  method: string;
  record: unknown;
  item: Record<string, unknown>;
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
    raw: args.record
  });
}

function codexAppServerToolResultObservation(args: {
  id: string;
  recordIndex: number;
  method: string;
  record: unknown;
  item: Record<string, unknown>;
}): NativeCliObservationEvent[] {
  const output =
    textValue(args.item.output, args.item.result, args.item.content, args.item.message, args.item.error) ??
    compactJson(args.item.output ?? args.item.result ?? args.item.content ?? args.item);
  return observation({
    id: `${args.id}:json:${args.recordIndex}:tool-result`,
    role: 'tool',
    text: output,
    source: 'codex-app-server',
    providerEventType: 'function_call_output',
    raw: args.record
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
  if (!method || !isCodexAppServerObservationMethod(method)) return [];
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
    return codexAppServerToolCallObservation({ id, recordIndex, method, record, item });
  }
  if (method === 'item/completed') {
    const item = codexAppServerItemRecord(p);
    if (!item) return [];
    if (isCodexObservationResponseItem(item)) {
      const responseItem = codexResponseItem(id, item, recordIndex, 'codex-app-server', record);
      if (responseItem.length > 0) return responseItem;
    }
    if (!isCodexAppServerToolLikeItem(item)) return [];
    return codexAppServerToolResultObservation({ id, recordIndex, method, record, item });
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
  if (method === 'turn/started' || method === 'turn/completed' || method === 'thread/status/changed') {
    return observation({
      id: `${id}:json:${recordIndex}:status`,
      role: 'system',
      text: textValue(p.status, p.type) ?? method,
      source: 'codex-app-server',
      providerEventType: method,
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
