import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk';
import type {
  CodexAppServerNotification,
  CodexAppServerResponseItem,
  CodexAppServerServerRequest,
  NativeCliObservationEvent,
  NativeCliProvider
} from '@monad/protocol';

import { nativeCliObservationEventSchema } from '@monad/protocol';

type ObservationRole = NativeCliObservationEvent['role'];
type ObservationSource = NativeCliObservationEvent['source'];
type CodexObservationResponseItem = Partial<CodexAppServerResponseItem> & Record<string, unknown> & { type: string };
type CodexObservationNotification = Partial<CodexAppServerNotification | CodexAppServerServerRequest> &
  Record<string, unknown> & { method: string };
type ClaudeObservationMessage = Partial<SDKMessage> & Record<string, unknown> & { type: string };
type ClaudeTranscriptMessage = Partial<SDKAssistantMessage | SDKUserMessage> &
  Record<string, unknown> & { type: 'assistant' | 'user' };
type ClaudeResultMessage = Partial<SDKResultMessage> & Record<string, unknown> & { type: 'result' };
type ClaudeStreamEventMessage = Partial<SDKPartialAssistantMessage> &
  Record<string, unknown> & { type: 'stream_event' };
type ClaudeSystemMessage = Partial<SDKSystemMessage> & Record<string, unknown> & { type: 'system' };
type NativeCliObservationStreamItem = NativeCliObservationEvent;
type JsonRecordEntry = {
  record: Record<string, unknown>;
  raw: string;
};

const CODEX_APP_SERVER_METHODS = new Set([
  'thread/started',
  'thread/status/changed',
  'turn/started',
  'turn/completed',
  'turn/failed',
  'turn/diff/updated',
  'turn/plan/updated',
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/plan/delta',
  'item/reasoning/textDelta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'rawResponseItem/completed',
  'command/exec/outputDelta',
  'process/outputDelta',
  'process/exited',
  'item/commandExecution/outputDelta',
  'item/commandExecution/terminalInteraction',
  'item/fileChange/outputDelta',
  'item/fileChange/patchUpdated',
  'serverRequest/resolved',
  'item/mcpToolCall/progress',
  'mcpServer/oauthLogin/completed',
  'mcpServer/startupStatus/updated',
  'error',
  'warning',
  'guardianWarning',
  'configWarning',
  'deprecationNotice'
]);

function observation(args: {
  id: string;
  role: ObservationRole;
  text?: string;
  source: ObservationSource;
  providerEventType?: string;
  raw?: unknown;
  preserveWhitespace?: boolean;
}): NativeCliObservationEvent[] {
  const text = args.preserveWhitespace ? args.text : args.text?.trim();
  if (!text) return [];
  const parsed = nativeCliObservationEventSchema.safeParse({
    id: args.id,
    role: args.role,
    text,
    source: args.source,
    providerEventType: args.providerEventType,
    raw: args.raw
  });
  return parsed.success ? [parsed.data] : [];
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function isCodexObservationResponseItem(item: unknown): item is CodexObservationResponseItem {
  return (
    !!item && typeof item === 'object' && !Array.isArray(item) && typeof (item as { type?: unknown }).type === 'string'
  );
}

function isCodexObservationNotification(record: Record<string, unknown>): record is CodexObservationNotification {
  return typeof record.method === 'string';
}

function isClaudeObservationMessage(record: Record<string, unknown>): record is ClaudeObservationMessage {
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

function jsonObjectsInText(text: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === '\\') {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char !== '}' || depth === 0) continue;
    depth -= 1;
    if (depth !== 0 || start < 0) continue;
    const record = parseJsonObject(text.slice(start, index + 1));
    if (record) records.push(record);
    start = -1;
  }
  return records;
}

function jsonRecordEntries(text: string): JsonRecordEntry[] {
  if (!text.includes('{')) return [];
  const trimmed = text.trim();
  const whole = parseJsonObject(trimmed);
  if (whole) return [{ record: whole, raw: trimmed }];
  const lineRecords = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map((line) => {
      const record = parseJsonObject(line);
      return record ? { record, raw: line } : undefined;
    })
    .filter((entry): entry is JsonRecordEntry => !!entry);
  if (lineRecords.length > 0) return lineRecords;
  return jsonObjectsInText(text).map((record) => ({ record, raw: JSON.stringify(record) }));
}

function parsedJsonEvents(args: {
  id: string;
  provider?: NativeCliProvider | string;
  entries: JsonRecordEntry[];
}): NativeCliObservationEvent[] {
  return args.entries.flatMap((entry, index) => {
    const events = recordEvents(args.id, args.provider, entry.record, index);
    if (events.length > 0) return events;
    return rawJsonObservation(args.id, entry.raw, entry.record, index);
  });
}

function rawJsonObservation(
  id: string,
  rawLine: string,
  record: Record<string, unknown>,
  recordIndex: number
): NativeCliObservationEvent[] {
  return observation({
    id: `${id}:json:${recordIndex}:raw`,
    role: 'system',
    text: rawLine,
    source: 'unknown',
    providerEventType: 'raw_json',
    raw: record,
    preserveWhitespace: true
  });
}

function textValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function compactJson(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.trim() || undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function commandText(command: unknown): string | undefined {
  if (Array.isArray(command))
    return (
      command
        .map((part) => String(part))
        .join(' ')
        .trim() || undefined
    );
  return textValue(command);
}

function resultMarkerText(record: Record<string, unknown>): string {
  const subtype = textValue(record.subtype) ?? (record.is_error ? 'error' : 'completed');
  const stopReason = textValue(record.stop_reason);
  return stopReason ? `Result: ${subtype} (${stopReason})` : `Result: ${subtype}`;
}

function claudeResultText(record: ClaudeResultMessage): string {
  return textValue(record.result) ?? textValue(record.response) ?? resultMarkerText(record);
}

// Streaming deltas carry their own boundary whitespace (a space after a period, a
// leading space on the next fragment). Trimming here would drop it, and the chunk
// merge cannot re-insert a space after clause punctuation — so keep deltas verbatim.
function rawTextValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function contentEvents(args: {
  id: string;
  content: unknown;
  recordIndex: number;
  source: ObservationSource;
  providerEventType?: string;
  raw: unknown;
  baseSource?: string;
}): NativeCliObservationEvent[] {
  if (typeof args.content === 'string') {
    return observation({
      id: `${args.id}:json:${args.recordIndex}:${args.baseSource ?? 'message'}`,
      role: 'agent',
      text: args.content,
      source: args.source,
      providerEventType: args.providerEventType,
      raw: args.raw
    });
  }
  if (!Array.isArray(args.content)) return [];
  return args.content.flatMap((part, partIndex) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return [];
    const item = part as Record<string, unknown>;
    const text = textValue(item.text, item.content);
    if (item.type === 'text' && text) {
      return observation({
        id: `${args.id}:json:${args.recordIndex}:${args.baseSource ?? 'message'}:${partIndex}`,
        role: 'agent',
        text,
        source: args.source,
        providerEventType: args.providerEventType,
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
        raw: args.raw
      });
    }
    return [];
  });
}

function permissionDenialEvents(
  id: string,
  denials: unknown,
  source: ObservationSource,
  recordIndex?: number
): NativeCliObservationEvent[] {
  if (!Array.isArray(denials)) return [];
  const prefix = recordIndex === undefined ? id : `${id}:json:${recordIndex}`;
  return denials.flatMap((denial, index) => {
    if (!denial || typeof denial !== 'object' || Array.isArray(denial)) return [];
    const record = denial as Record<string, unknown>;
    const toolInput = record.tool_input;
    const input =
      toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)
        ? (toolInput as Record<string, unknown>)
        : {};
    const label = textValue(record.tool_name) ?? 'tool';
    const detail = textValue(input.command, input.description);
    return observation({
      id: `${prefix}:denial:${index}`,
      role: 'tool',
      text: detail ? `Permission blocked ${label}: ${detail}` : `Permission blocked ${label}`,
      source,
      providerEventType: 'permission_denial',
      raw: denial
    });
  });
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

function codexExecRecordEvents(
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

function codexAppServerRecordEvents(
  id: string,
  record: CodexObservationNotification,
  recordIndex: number
): NativeCliObservationEvent[] {
  const method = record.method;
  if (!method || !CODEX_APP_SERVER_METHODS.has(method)) return [];
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

function claudeRecordEvents(
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

function geminiRecordEvents(
  id: string,
  record: Record<string, unknown>,
  recordIndex: number
): NativeCliObservationEvent[] {
  const type = record.type;
  if (type === 'message') {
    return observation({
      id: `${id}:json:${recordIndex}:message`,
      role: 'agent',
      text: textValue(record.text, record.content, record.delta, record.message),
      source: 'gemini-cli',
      providerEventType: 'message',
      raw: record
    });
  }
  if (type === 'tool_use') {
    const tool = textValue(record.name, record.tool) ?? 'tool';
    const input = record.args ?? record.arguments ?? record.input;
    const inputText = input === undefined ? '' : ` ${typeof input === 'string' ? input : JSON.stringify(input)}`;
    return observation({
      id: `${id}:json:${recordIndex}:tool-use`,
      role: 'tool',
      text: `Tool call ${tool}${inputText}`,
      source: 'gemini-cli',
      providerEventType: 'tool_use',
      raw: record
    });
  }
  if (type === 'tool_result') {
    return observation({
      id: `${id}:json:${recordIndex}:tool-result`,
      role: 'tool',
      text: textValue(record.output, record.result, record.content) ?? JSON.stringify(record),
      source: 'gemini-cli',
      providerEventType: 'tool_result',
      raw: record
    });
  }
  if (type === 'error') {
    return observation({
      id: `${id}:json:${recordIndex}:error`,
      role: 'system',
      text: textValue(record.message, record.error) ?? JSON.stringify(record),
      source: 'gemini-cli',
      providerEventType: 'error',
      raw: record
    });
  }
  if (type === 'result') {
    return observation({
      id: `${id}:json:${recordIndex}:result`,
      role: 'agent',
      text: textValue(record.response, record.result, record.text),
      source: 'gemini-cli',
      providerEventType: 'result',
      raw: record
    });
  }
  return [];
}

function unknownJsonRpcError(
  id: string,
  record: Record<string, unknown>,
  recordIndex: number
): NativeCliObservationEvent[] {
  if (record.error && typeof record.error === 'object' && !Array.isArray(record.error)) {
    const error = record.error as Record<string, unknown>;
    return observation({
      id: `${id}:json:${recordIndex}:error`,
      role: 'system',
      text: textValue(error.message, error.code) ?? JSON.stringify(error),
      source: 'unknown',
      providerEventType: 'error',
      raw: record
    });
  }
  return [];
}

function recordEvents(
  id: string,
  provider: NativeCliProvider | string | undefined,
  record: Record<string, unknown>,
  recordIndex: number
): NativeCliObservationEvent[] {
  if (isCodexObservationNotification(record)) {
    const appServer = codexAppServerRecordEvents(id, record, recordIndex);
    if (appServer.length > 0) return appServer;
  }
  if (provider === 'codex') {
    const codex = codexExecRecordEvents(id, record, recordIndex);
    if (codex.length > 0) return codex;
  }
  if (provider === 'claude-code' && isClaudeObservationMessage(record)) {
    const claude = claudeRecordEvents(id, record, recordIndex);
    if (claude.length > 0) return claude;
  }
  if (provider === 'gemini') {
    const gemini = geminiRecordEvents(id, record, recordIndex);
    if (gemini.length > 0) return gemini;
  }
  return [
    ...codexExecRecordEvents(id, record, recordIndex),
    ...(isClaudeObservationMessage(record) ? claudeRecordEvents(id, record, recordIndex) : []),
    ...geminiRecordEvents(id, record, recordIndex),
    ...unknownJsonRpcError(id, record, recordIndex)
  ];
}

function removeAdjacentDuplicateObservations(events: NativeCliObservationEvent[]): NativeCliObservationEvent[] {
  const out: NativeCliObservationEvent[] = [];
  for (const event of events) {
    const previous = out.at(-1);
    if (
      previous &&
      previous.role === event.role &&
      previous.source === event.source &&
      previous.text.trim() === event.text.trim()
    ) {
      // A result whose text just repeats the assistant message it settles still marks a
      // query boundary — keep it as a compact marker instead of dropping it outright.
      if (
        event.providerEventType === 'result' &&
        event.raw &&
        typeof event.raw === 'object' &&
        !Array.isArray(event.raw)
      ) {
        out.push({ ...event, text: resultMarkerText(event.raw as Record<string, unknown>) });
      }
      continue;
    }
    out.push(event);
  }
  return out;
}

function isChunkObservation(event: NativeCliObservationEvent): boolean {
  return event.providerEventType?.endsWith('/delta') === true || event.providerEventType?.endsWith('Delta') === true;
}

// Streaming deltas are emitted to be concatenated verbatim: each already carries its own
// boundary whitespace (codex sends " the", " CLI"; a mid-word split sends "impl" then
// "ementation"). Guessing a space between two alphanumeric edges corrupts both cases —
// it inserts a spurious space inside a split word and, worse, between CJK characters that
// never take inter-character spaces (我来 + 先做 → "我来 先做"). Always join verbatim.
function appendChunkText(previous: string, next: string): string {
  return `${previous}${next}`;
}

function mergeAdjacentChunkObservations(events: NativeCliObservationEvent[]): NativeCliObservationEvent[] {
  const out: NativeCliObservationEvent[] = [];
  for (const event of events) {
    const previous = out.at(-1);
    if (
      previous &&
      isChunkObservation(previous) &&
      isChunkObservation(event) &&
      previous.role === event.role &&
      previous.source === event.source &&
      previous.providerEventType === event.providerEventType
    ) {
      out[out.length - 1] = {
        ...previous,
        text: appendChunkText(previous.text, event.text),
        raw: [previous.raw, event.raw]
      };
      continue;
    }
    out.push(event);
  }
  // Deltas were kept verbatim to preserve internal boundary whitespace; trim the
  // outer edges of each merged block and drop chunks that were whitespace-only.
  return out.flatMap((event) => {
    if (!isChunkObservation(event)) return [event];
    const text = event.text.trim();
    return text ? [{ ...event, text }] : [];
  });
}

function nativeCliObservationEvents(args: {
  id: string;
  provider?: NativeCliProvider | string;
  output?: string;
}): NativeCliObservationEvent[] | undefined {
  const text = args.output?.trim();
  if (!text) return [];
  const entries = jsonRecordEntries(text);
  if (entries.length > 0) {
    return removeAdjacentDuplicateObservations(
      mergeAdjacentChunkObservations(parsedJsonEvents({ id: args.id, provider: args.provider, entries }))
    );
  }
  return undefined;
}

export function nativeCliStreamItems(args: {
  id: string;
  provider?: NativeCliProvider | string;
  output?: string;
}): NativeCliObservationStreamItem[] {
  const text = args.output?.trim();
  if (!text) return [];
  const structured = nativeCliObservationEvents(args);
  if (structured) return structured;
  return text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part, index) => ({
      id: `${args.id}:${index}`,
      role: part.startsWith('tool:') ? ('tool' as const) : ('agent' as const),
      text: part,
      source: 'plain-text' as const
    }));
}
