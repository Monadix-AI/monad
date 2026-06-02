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
  const tool = result.tool ?? call.tool;
  const shellCommand = shellCommandInput(name, call.tool?.input ?? result.tool?.input);
  const command = standaloneResult
    ? structuredText(result.tool?.input)
    : (shellCommand ?? structuredText(call.tool?.input ?? result.tool?.input) ?? toolCallTextInput(call.text));
  const output = standaloneCall ? undefined : (structuredText(result.tool?.output) ?? result.text);
  const jsonOutput = output ? jsonCodeText(output) : null;
  return {
    type: name,
    provider,
    command,
    commandLanguage: shellCommand ? 'bash' : command && jsonCodeText(command) ? 'json' : 'bash',
    cwd: tool?.cwd,
    status: tool?.status,
    exitCode: tool?.exitCode,
    durationMs: tool?.durationMs,
    output: tool?.status ? output : (jsonOutput ?? output),
    outputLanguage: jsonOutput ? 'json' : commandOutputLanguage(output)
  };
}

function shellCommandInput(name: string, input: unknown): string | undefined {
  if (!['bash', 'shell'].includes(name.toLowerCase())) return undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const command = (input as Record<string, unknown>).command;
  return typeof command === 'string' && command.trim() ? command.trim() : undefined;
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
