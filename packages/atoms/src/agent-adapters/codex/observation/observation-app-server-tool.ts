import type { MeshAgentObservationEvent } from '@monad/protocol';

import { compactJson, observation, rawTextValue, recordValue, textValue } from '../../observation-projection.ts';

export function codexAppServerItemRecord(p: Record<string, unknown>): Record<string, unknown> | undefined {
  const item = p.item;
  if (item && typeof item === 'object' && !Array.isArray(item)) return item as Record<string, unknown>;
  return p;
}

function codexSemanticToolName(item: Record<string, unknown>): string | undefined {
  const action = recordValue(item.action);
  const input = recordValue(item.input);
  const value = textValue(action?.name, input?.name, action?.type, input?.type);
  if (!value || value.toLowerCase() === 'tool') return undefined;
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}

function codexAppServerToolName(item: Record<string, unknown>, fallback = 'tool'): string {
  const explicitName = textValue(item.name, item.tool, item.toolName);
  if (explicitName && explicitName.toLowerCase() !== 'tool') return explicitName;
  const semanticName = codexSemanticToolName(item);
  if (semanticName) return semanticName;
  const itemType = textValue(item.kind, item.type);
  if (itemType?.toLowerCase() === 'filechange') return 'File change';
  if (itemType && ['websearch', 'web_search', 'web_search_call'].includes(itemType.toLowerCase())) return 'Search';
  return explicitName ?? itemType ?? fallback;
}

function isCodexAppServerWebSearchItem(item: Record<string, unknown>): boolean {
  const type = textValue(item.type, item.kind, item.itemType)?.toLowerCase();
  const actionType = textValue(recordValue(item.action)?.type, recordValue(item.input)?.type)?.toLowerCase();
  return type === 'websearch' || type === 'web_search' || type === 'web_search_call' || actionType === 'search';
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
    normalizedType.includes('image') ||
    normalizedType.includes('websearch') ||
    normalizedType.includes('web_search')
  );
}

function codexAppServerToolInput(item: Record<string, unknown>): unknown {
  return (
    item.arguments ??
    item.input ??
    item.args ??
    item.action ??
    item.command ??
    item.path ??
    item.query ??
    item.revisedPrompt
  );
}

export function hasCodexAppServerToolInput(item: Record<string, unknown>): boolean {
  return (
    item.arguments !== undefined ||
    item.input !== undefined ||
    item.args !== undefined ||
    item.action !== undefined ||
    item.command !== undefined ||
    item.path !== undefined ||
    item.query !== undefined ||
    item.revisedPrompt !== undefined
  );
}

export function hasCodexAppServerToolOutput(item: Record<string, unknown>): boolean {
  return (
    isCodexAppServerWebSearchItem(item) ||
    item.changes !== undefined ||
    item.output !== undefined ||
    item.result !== undefined ||
    item.results !== undefined ||
    item.content !== undefined ||
    item.aggregatedOutput !== undefined ||
    item.aggregated_output !== undefined ||
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
}): MeshAgentObservationEvent[] {
  const recordKey = textValue(args.item.id) ?? String(args.recordIndex);
  const tool = codexAppServerToolName(args.item);
  const input = codexAppServerToolInput(args.item);
  const inputText = compactJson(input);
  return observation({
    id: `${args.id}:json:${recordKey}:tool-call`,
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
}): MeshAgentObservationEvent[] {
  const recordKey = textValue(args.item.id) ?? String(args.recordIndex);
  const imageResult =
    textValue(args.item.type)?.toLowerCase() === 'imagegeneration'
      ? textValue(args.item.savedPath, args.item.saved_path)
      : undefined;
  const output =
    imageResult ??
    textValue(
      args.item.output,
      args.item.result,
      args.item.results,
      args.item.content,
      args.item.message,
      args.item.error,
      args.item.aggregatedOutput,
      args.item.aggregated_output
    ) ??
    codexMcpContentText(
      args.item.result ??
        args.item.results ??
        args.item.output ??
        args.item.content ??
        args.item.aggregatedOutput ??
        args.item.aggregated_output
    ) ??
    compactJson(
      args.item.output ??
        args.item.result ??
        args.item.results ??
        args.item.content ??
        args.item.aggregatedOutput ??
        args.item.aggregated_output ??
        (isCodexAppServerWebSearchItem(args.item) ? { status: textValue(args.item.status) ?? 'completed' } : args.item)
    );
  return observation({
    id: `${args.id}:json:${recordKey}${args.itemIndex === undefined ? '' : `:${args.itemIndex}`}:tool-result`,
    role: 'tool',
    text: output,
    source: 'codex-app-server',
    providerEventType: 'function_call_output',
    createdAt: args.createdAt,
    raw: args.record
  });
}
