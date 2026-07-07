import type { CSSProperties } from 'react';
import type { BundledLanguage } from 'shiki';
import type { FileReadToolView, ObservationItem } from './types.ts';

import { workspaceMono as mono } from '@monad/ui/components/AgentAvatar';
import { CodeBlock } from '@monad/ui/components/CodeBlock';

import { ObservationMeta } from './card-shell.tsx';

export function FileReadToolCard({ view }: { view: FileReadToolView }): React.ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      <div style={filePathStyle}>{view.path}</div>
      <CodeBlock
        className="rounded-md border border-[color-mix(in_srgb,var(--border)_78%,transparent)] bg-[color-mix(in_srgb,var(--background)_82%,black)] text-[11px] [&>div::-webkit-scrollbar]:hidden [&>div]:max-h-72 [&>div]:overflow-auto [&>div]:[scrollbar-width:none] [&_pre]:p-0"
        code={view.content}
        language={languageFromPath(view.path)}
      />
    </div>
  );
}

export function FileReadToolHeader({ view }: { view: FileReadToolView }): React.ReactElement {
  return (
    <ObservationMeta
      compact
      label="tool call"
      showSource={false}
      source={view.provider}
      title={view.type}
    />
  );
}

export function fileReadToolView(
  call: ObservationItem,
  result: ObservationItem,
  provider: string
): FileReadToolView | null {
  return claudeReadToolView(call, result, provider);
}

function claudeReadToolView(call: ObservationItem, result: ObservationItem, provider: string): FileReadToolView | null {
  const input = claudeToolInput(call.raw);
  if (input?.name !== 'Read') return null;
  const content = claudeToolOutput(result.raw) ?? result.text;
  if (!content) return null;
  return {
    type: 'Read',
    provider,
    path: input.path,
    content
  };
}

function claudeToolInput(raw: unknown): { name: string; path: string } | null {
  const toolUse = claudeToolUseRecord(raw);
  if (!toolUse) return null;
  const name = stringFrom(toolUse.name);
  if (!name) return null;
  const input = toolUse.input;
  const path =
    input && typeof input === 'object' && !Array.isArray(input)
      ? stringFrom(
          (input as Record<string, unknown>).file_path,
          (input as Record<string, unknown>).filePath,
          (input as Record<string, unknown>).path
        )
      : stringFrom(input);
  return path ? { name, path } : null;
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

function languageFromPath(path: string): BundledLanguage {
  const suffix = path.split(/[?#]/, 1)[0]?.split('.').pop()?.toLowerCase();
  switch (suffix) {
    case 'cjs':
    case 'js':
    case 'jsx':
    case 'mjs':
      return 'javascript';
    case 'cts':
    case 'mts':
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'json':
    case 'jsonc':
      return 'json';
    case 'md':
    case 'mdx':
      return 'markdown';
    case 'css':
      return 'css';
    case 'html':
      return 'html';
    case 'py':
      return 'python';
    case 'rb':
      return 'ruby';
    case 'rs':
      return 'rust';
    case 'go':
      return 'go';
    case 'java':
      return 'java';
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'bash';
    case 'sql':
      return 'sql';
    case 'yaml':
    case 'yml':
      return 'yaml';
    default:
      return 'markdown';
  }
}

const filePathStyle: CSSProperties = {
  maxWidth: '100%',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--muted-foreground)',
  fontFamily: mono,
  fontSize: 11
};
