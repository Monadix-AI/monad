import type { CSSProperties } from 'react';
import type { BundledLanguage } from 'shiki';
import type { CommandToolView, ObservationItem } from './types.ts';

import { ObservationMeta } from '@monad/ui';
import { workspaceMono as mono } from '@monad/ui/components/AgentAvatar';
import { CodeBlock } from '@monad/ui/components/CodeBlock';

export function CommandToolCard({ view }: { view: CommandToolView }): React.ReactElement {
  return (
    <CommandIoCard
      input={view.command}
      inputLanguage={view.commandLanguage}
      output={view.output}
      outputLanguage={view.outputLanguage}
    />
  );
}

export function CommandToolHeader({ view }: { view: CommandToolView }): React.ReactElement {
  return (
    <ObservationMeta
      compact
      label="tool call"
      showSource={false}
      source={view.provider}
      title={view.type}
    >
      <span style={commandStatusStyle(view.status, view.exitCode)}>{commandStatusLabel(view)}</span>
      {view.durationMs !== undefined ? (
        <span style={commandMetaChipStyle}>{formatDurationMs(view.durationMs)}</span>
      ) : null}
      {view.cwd ? <span style={commandMetaChipStyle}>{view.cwd}</span> : null}
    </ObservationMeta>
  );
}

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

function CommandIoCard({
  input,
  inputLanguage,
  output,
  outputLanguage
}: {
  input?: string;
  inputLanguage?: string;
  output?: string;
  outputLanguage?: string;
}): React.ReactElement {
  return (
    <div style={commandIoCardStyle}>
      {input ? (
        <CommandCodeSection
          code={input}
          label="input"
          language={bundledLanguage(inputLanguage, 'bash')}
        />
      ) : null}
      {output ? (
        <CommandCodeSection
          code={output}
          label="output"
          language={bundledLanguage(outputLanguage, commandOutputLanguage(output))}
        />
      ) : null}
    </div>
  );
}

function CommandCodeSection({
  code,
  label,
  language
}: {
  code: string;
  label: string;
  language: BundledLanguage;
}): React.ReactElement {
  return (
    <section style={commandCodeSectionStyle(label)}>
      <div style={commandCodeLabelStyle}>{label}</div>
      <CodeBlock
        className="rounded-md border-0 bg-transparent text-[11px] [&>div::-webkit-scrollbar]:hidden [&>div]:max-h-72 [&>div]:overflow-auto [&>div]:[scrollbar-width:none] [&_pre]:p-0"
        code={code}
        language={language}
      />
    </section>
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

function bundledLanguage(value: string | undefined, fallback: BundledLanguage): BundledLanguage {
  switch (value) {
    case 'bash':
    case 'css':
    case 'go':
    case 'html':
    case 'java':
    case 'javascript':
    case 'json':
    case 'markdown':
    case 'python':
    case 'ruby':
    case 'rust':
    case 'sql':
    case 'typescript':
    case 'yaml':
      return value;
    default:
      return fallback;
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

function commandStatusLabel(view: CommandToolView): string {
  if (view.exitCode !== undefined) return view.exitCode === 0 ? 'completed' : `exit ${view.exitCode}`;
  return view.status ?? 'running';
}

function statusFromResultText(text: string | undefined): string {
  return text && /\b(error|failed|denied|blocked|permission)\b/i.test(text) ? 'failed' : 'completed';
}

function formatDurationMs(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

const commandMetaChipStyle: CSSProperties = {
  maxWidth: '100%',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  border: '1px solid color-mix(in srgb, var(--border) 78%, transparent)',
  borderRadius: 999,
  background: 'color-mix(in srgb, var(--background) 76%, transparent)',
  color: 'var(--muted-foreground)',
  fontFamily: mono,
  fontSize: 10,
  padding: '2px 7px'
};

const commandIoCardStyle: CSSProperties = {
  boxSizing: 'border-box',
  maxWidth: '100%',
  border: '1px solid color-mix(in srgb, #f59e0b 40%, var(--border))',
  borderRadius: 8,
  background: 'color-mix(in srgb, #f59e0b 9%, var(--background))',
  overflow: 'hidden'
};

function commandCodeSectionStyle(label: string): CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    minWidth: 0,
    borderTop: label === 'input' ? '0' : '1px solid color-mix(in srgb, var(--border) 70%, transparent)',
    background:
      label === 'input'
        ? 'color-mix(in srgb, var(--foreground) 5%, var(--background))'
        : 'color-mix(in srgb, #f59e0b 8%, var(--background))',
    padding: '8px 9px'
  };
}

const commandCodeLabelStyle: CSSProperties = {
  color: 'var(--foreground)',
  fontFamily: mono,
  fontSize: 10,
  fontWeight: 700,
  lineHeight: 1,
  textTransform: 'uppercase'
};

function commandStatusStyle(status: string | undefined, exitCode: number | undefined): CSSProperties {
  const failed = exitCode !== undefined ? exitCode !== 0 : status === 'failed' || status === 'error';
  return {
    ...commandMetaChipStyle,
    borderColor: failed
      ? 'color-mix(in srgb, #ef4444 52%, var(--border))'
      : 'color-mix(in srgb, #22c55e 46%, var(--border))',
    background: failed
      ? 'color-mix(in srgb, #ef4444 10%, var(--background))'
      : 'color-mix(in srgb, #22c55e 10%, var(--background))',
    color: failed
      ? 'color-mix(in srgb, #ef4444 82%, var(--foreground))'
      : 'color-mix(in srgb, #22c55e 78%, var(--foreground))'
  };
}
