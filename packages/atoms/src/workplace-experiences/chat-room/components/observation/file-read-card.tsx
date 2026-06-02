import type { FileReadToolView, ObservationItem } from './types.ts';

export { FileReadCard as FileReadToolCard, FileReadCardHeader as FileReadToolHeader } from '@monad/ui';

export function fileReadToolView(
  call: ObservationItem,
  result: ObservationItem,
  provider: string
): FileReadToolView | null {
  const name = call.tool?.name;
  if (!name || !/(?:read|open|cat)/i.test(name)) return null;
  const path = toolPath(call.tool?.input);
  const content = toolOutput(result.tool?.output) ?? result.text;
  return path && content ? { type: name, provider, path, content } : null;
}

function toolPath(input: unknown): string | undefined {
  if (typeof input === 'string') return input.trim() || undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  for (const value of [record.path, record.filePath, record.file_path]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function toolOutput(output: unknown): string | undefined {
  if (typeof output === 'string') return output.trim() || undefined;
  if (output === undefined || output === null) return undefined;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}
