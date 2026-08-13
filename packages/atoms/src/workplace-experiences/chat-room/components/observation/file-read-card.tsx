import type { FileReadToolView, ObservationItem } from './types.ts';

import { FileReadCardHeader } from '@monad/ui';

import { workplaceExperienceT } from '../../../i18n.ts';

export { FileReadCard as FileReadToolCard } from '@monad/ui';

export function FileReadToolHeader({
  completed,
  quiet = false,
  view
}: {
  completed: boolean;
  quiet?: boolean;
  view: FileReadToolView;
}): React.ReactElement {
  const t = workplaceExperienceT();
  return (
    <FileReadCardHeader
      quiet={quiet}
      title={t(completed ? 'web.workplace.fileRead.read' : 'web.workplace.fileRead.reading')}
      view={view}
    />
  );
}

export function isFileReadToolCall(call: ObservationItem): boolean {
  const name = call.tool?.name;
  return typeof name === 'string' && /(?:read|open|cat)/i.test(name);
}

export function fileReadToolView(
  call: ObservationItem,
  result: ObservationItem,
  provider: string
): FileReadToolView | null {
  const name = call.tool?.name;
  if (!name || !isFileReadToolCall(call)) return null;
  const path = fileReadToolPath(call);
  const content = toolOutput(result.tool?.output) ?? result.text;
  return path && content ? { type: name, provider, path, content } : null;
}

export function fileReadToolPath(call: ObservationItem): string | undefined {
  return toolPath(call.tool?.input);
}

function toolPath(input: unknown): string | undefined {
  if (typeof input === 'string') {
    const value = input.trim();
    if (!value) return undefined;
    if (value.startsWith('{') || value.startsWith('[')) {
      try {
        return toolPath(JSON.parse(value));
      } catch {
        for (const key of ['path', 'filePath', 'file_path']) {
          const partial = partialJsonStringField(value, key);
          if (partial) return partial.replace(/[\\/]+$/, '') || partial;
        }
        return undefined;
      }
    }
    return value;
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  for (const value of [record.path, record.filePath, record.file_path]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function partialJsonStringField(input: string, key: string): string | undefined {
  const match = new RegExp(`"${key}"\\s*:\\s*"`).exec(input);
  if (!match) return undefined;
  let value = '';
  for (let index = match.index + match[0].length; index < input.length; index += 1) {
    const char = input[index];
    if (char === '"') return value || undefined;
    if (char !== '\\') {
      value += char;
      continue;
    }
    const escaped = input[index + 1];
    if (escaped === undefined) break;
    index += 1;
    if (escaped === 'u') {
      const hex = input.slice(index + 1, index + 5);
      if (!/^[\da-fA-F]{4}$/.test(hex)) break;
      value += String.fromCharCode(Number.parseInt(hex, 16));
      index += 4;
      continue;
    }
    const escapes: Record<string, string> = {
      '"': '"',
      '\\': '\\',
      '/': '/',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t'
    };
    value += escapes[escaped] ?? escaped;
  }
  return value || undefined;
}

function toolOutput(output: unknown): string | undefined {
  if (typeof output === 'string') return output.length > 0 ? output : undefined;
  if (output === undefined || output === null) return undefined;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}
