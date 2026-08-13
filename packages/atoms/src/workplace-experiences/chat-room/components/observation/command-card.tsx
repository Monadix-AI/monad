import type { BundledLanguage } from 'shiki';
import type { CommandToolView, ObservationItem } from './types.ts';

export { CommandCard as CommandToolCard, CommandCardHeader as CommandToolHeader } from '@monad/ui';

export function commandToolView(
  call: ObservationItem,
  result: ObservationItem,
  provider: string
): CommandToolView | null {
  const standaloneResult = call === result && result.kind === 'tool-result';
  const standaloneCall = call === result && call.kind === 'tool-call';
  const name =
    standaloneResult && result.tool?.name === 'tool' ? 'tool-result' : (call.tool?.name ?? result.tool?.name);
  if (!name) return null;
  const shellCommand = shellCommandInput(
    name,
    call.tool?.input ?? result.tool?.input,
    call.tool?.category ?? result.tool?.category
  );
  const command = standaloneResult
    ? structuredText(result.tool?.input)
    : (shellCommand ?? structuredText(call.tool?.input ?? result.tool?.input) ?? toolCallTextInput(call.text));
  const output = standaloneCall ? undefined : (structuredOutputText(result.tool?.output) ?? result.text);
  const jsonOutput = output ? jsonCodeText(output) : null;
  return {
    type: name,
    provider,
    command,
    commandLanguage: shellCommand ? 'bash' : command && jsonCodeText(command) ? 'json' : 'bash',
    cwd: result.tool?.cwd ?? call.tool?.cwd,
    status: result.tool?.status ?? call.tool?.status,
    exitCode: result.tool?.exitCode ?? call.tool?.exitCode,
    durationMs: result.tool?.durationMs ?? call.tool?.durationMs,
    output,
    outputLanguage: jsonOutput ? 'json' : commandOutputLanguage(output)
  };
}

function shellCommandInput(name: string, input: unknown, category: string | undefined): string | undefined {
  if (category !== 'shell' && !['bash', 'shell'].includes(name.toLowerCase())) return undefined;
  if (typeof input === 'string') return input.trim() || undefined;
  if (Array.isArray(input) && input.every((part) => typeof part === 'string'))
    return input.join(' ').trim() || undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  const command = record.command ?? record.cmd;
  if (typeof command === 'string') return command.trim() || undefined;
  return Array.isArray(command) && command.every((part) => typeof part === 'string')
    ? command.join(' ').trim() || undefined
    : undefined;
}

function toolCallTextInput(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const match = /^Tool call\s+[^\s]+\s+(.+)$/s.exec(text.trim());
  return match?.[1] ? structuredTextFromJson(match[1]) : text;
}

function structuredTextFromJson(value: string): string {
  try {
    return JSON.stringify(z.json().parse(JSON.parse(value)), null, 2);
  } catch {
    return value;
  }
}

function structuredText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function structuredOutputText(value: unknown): string | undefined {
  if (typeof value !== 'string') return structuredText(value);
  return value.length > 0 ? value : undefined;
}

function commandOutputLanguage(text: string | undefined): BundledLanguage {
  return text && jsonCodeText(text) ? 'json' : 'bash';
}

function jsonCodeText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = z.json().parse(JSON.parse(trimmed));
    if (typeof parsed === 'string') return jsonCodeText(parsed);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return null;
  }
}

import { z } from 'zod';
