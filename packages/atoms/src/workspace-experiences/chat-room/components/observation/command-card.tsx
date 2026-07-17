import type { BundledLanguage } from 'shiki';
import type { CommandToolView, ObservationItem } from './types.ts';

export { CommandCard as CommandToolCard, CommandCardHeader as CommandToolHeader } from '@monad/ui';

export function commandToolView(
  call: ObservationItem,
  result: ObservationItem,
  provider: string
): CommandToolView | null {
  return (
    codexCommandExecutionView(call, result, provider) ??
    claudeBashToolView(call, result, provider) ??
    genericToolCallView(call, result, provider) ??
    standaloneToolResultView(call, provider)
  );
}

function commandOutputLanguage(text: string | undefined): BundledLanguage {
  if (text && jsonCodeText(text)) return 'json';
  return 'bash';
}

function jsonCodeText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'string') return jsonCodeText(parsed);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return null;
  }
}

function codexCommandExecutionView(
  call: ObservationItem,
  result: ObservationItem,
  provider: string
): CommandToolView | null {
  const item = rawCommandExecutionItem(result.raw) ?? rawCommandExecutionItem(call.raw);
  if (!item) return null;
  const command = stringFrom(item.command) ?? commandActionText(item.commandActions) ?? 'command';
  return {
    type: 'commandExecution',
    provider,
    command,
    cwd: stringFrom(item.cwd),
    status: stringFrom(item.status),
    exitCode: numberFrom(item.exitCode),
    durationMs: numberFrom(item.durationMs),
    output: stringFrom(item.aggregatedOutput, item.output, item.result, result.text)
  };
}

function claudeBashToolView(call: ObservationItem, result: ObservationItem, provider: string): CommandToolView | null {
  const input = claudeToolInput(call.raw);
  if (input?.name !== 'Bash') return null;
  const output = claudeToolOutput(result.raw) ?? result.text;
  return {
    type: 'Bash',
    provider,
    command: input.command,
    status: statusFromResultText(result.text),
    output
  };
}

function genericToolCallView(call: ObservationItem, result: ObservationItem, provider: string): CommandToolView | null {
  const parsed = parseToolCallText(call.text ?? '');
  if (!parsed) return null;
  const output = toolResultOutput(result);
  const jsonOutput = output ? jsonCodeText(output) : null;
  return {
    type: parsed.tool,
    provider,
    command: parsed.input,
    commandLanguage: parsed.language,
    status: output ? statusFromResultText(output) : statusFromResultText(result.text),
    output: jsonOutput ?? output ?? result.text,
    outputLanguage: jsonOutput ? 'json' : commandOutputLanguage(output ?? result.text)
  };
}

function standaloneToolResultView(item: ObservationItem, provider: string): CommandToolView | null {
  if (item.kind !== 'tool-result') return null;
  const output = toolResultOutput(item);
  if (!output) return null;
  const jsonOutput = jsonCodeText(output);
  return {
    type: 'tool-result',
    provider,
    status: statusFromResultText(output),
    output: jsonOutput ?? output,
    outputLanguage: jsonOutput ? 'json' : commandOutputLanguage(output)
  };
}

function parseToolCallText(text: string): { input: string; language: BundledLanguage; tool: string } | null {
  const match = /^Tool call\s+([^\s]+)\s+(.+)$/s.exec(text.trim());
  if (!match) return null;
  const [, tool, rawInput] = match;
  if (!tool || rawInput === undefined) return null;
  try {
    return { tool, input: JSON.stringify(JSON.parse(rawInput) as unknown, null, 2), language: 'json' };
  } catch {
    return { tool, input: rawInput, language: 'markdown' };
  }
}

function toolResultOutput(result: ObservationItem): string | undefined {
  const direct = outputFromRaw(result.raw);
  return direct ?? stringFrom(result.text);
}

function outputFromRaw(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const params = nestedRecord(record.params);
  const item = nestedRecord(params?.item) ?? nestedRecord(record.item);
  return stringFrom(
    item?.output,
    item?.result,
    item?.content,
    item?.message,
    item?.error,
    record.output,
    record.result,
    record.content
  );
}

function rawCommandExecutionItem(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.type === 'commandExecution') return record;
  const params = record.params;
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    const p = params as Record<string, unknown>;
    const item = p.item;
    if (
      item &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      (item as Record<string, unknown>).type === 'commandExecution'
    ) {
      return item as Record<string, unknown>;
    }
  }
  return null;
}

function claudeToolInput(raw: unknown): { name: string; command: string } | null {
  const toolUse = claudeToolUseRecord(raw);
  if (!toolUse) return null;
  const name = stringFrom(toolUse.name);
  if (!name) return null;
  const input = toolUse.input;
  const command =
    input && typeof input === 'object' && !Array.isArray(input)
      ? stringFrom((input as Record<string, unknown>).command, (input as Record<string, unknown>).description)
      : stringFrom(input);
  return command ? { name, command } : null;
}

function claudeToolUseRecord(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const contentBlock = nestedRecord(record.event, 'content_block');
  if (contentBlock?.type === 'tool_use') return contentBlock;
  const message = nestedRecord(record.message);
  const content = message?.content ?? record.content;
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
    const item = part as Record<string, unknown>;
    if (item.type === 'tool_use') return item;
  }
  return null;
}

function claudeToolOutput(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.type === 'tool_result') return stringFrom(record.output, record.result, record.content);
  const message = nestedRecord(record.message);
  const content = message?.content ?? record.content;
  if (!Array.isArray(content)) return stringFrom(record.output, record.result);
  const outputs: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
    const item = part as Record<string, unknown>;
    if (item.type !== 'tool_result') continue;
    const text = stringFrom(item.content, item.output, item.result);
    if (text) outputs.push(text);
  }
  return outputs.length > 0 ? outputs.join('\n') : undefined;
}

function nestedRecord(value: unknown, key?: string): Record<string, unknown> | null {
  const target =
    key && value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)[key]
      : value;
  return target && typeof target === 'object' && !Array.isArray(target) ? (target as Record<string, unknown>) : null;
}

function stringFrom(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function numberFrom(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function commandActionText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const action of value) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) continue;
    const command = stringFrom((action as Record<string, unknown>).command);
    if (command) return command;
  }
  return undefined;
}

function statusFromResultText(text: string | undefined): string {
  return text && /\b(error|failed|denied|blocked|permission)\b/i.test(text) ? 'failed' : 'completed';
}
