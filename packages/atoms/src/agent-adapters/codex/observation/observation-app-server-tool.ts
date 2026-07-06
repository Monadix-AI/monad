import type { NativeCliObservationEvent } from '@monad/protocol';

import { compactJson, observation, rawTextValue, recordValue, textValue } from '../../observation-projection.ts';

export function codexAppServerItemRecord(p: Record<string, unknown>): Record<string, unknown> | undefined {
  const item = p.item;
  if (item && typeof item === 'object' && !Array.isArray(item)) return item as Record<string, unknown>;
  return p;
}

function codexAppServerToolName(item: Record<string, unknown>, fallback = 'tool'): string {
  return textValue(item.name, item.tool, item.toolName, item.kind, item.type) ?? fallback;
}

export function isCodexAppServerToolLikeItem(item: Record<string, unknown>): boolean {
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

export function hasCodexAppServerToolInput(item: Record<string, unknown>): boolean {
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

export function hasCodexAppServerToolOutput(item: Record<string, unknown>): boolean {
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

export function codexAppServerToolCallObservation(args: {
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

export function codexAppServerToolResultObservation(args: {
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
