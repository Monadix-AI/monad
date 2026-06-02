import { type CodeLanguage, inferCodeLanguage, parseUnifiedDiff } from '@monad/ui';

export interface FileReadRow {
  content: string;
  kind: 'meta' | 'source';
  lineNumber: number | null;
}

export type FilePreviewLanguage = CodeLanguage;

function splitVisibleLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

export function buildFileReadRows(output: string, offset: number | undefined): FileReadRow[] {
  const lines = splitVisibleLines(output);
  const numberedLine = /^(\d+)\t(.*)$/;
  const isNote = (line: string) => line.startsWith('(partial read') || line.startsWith('(truncated;');
  const hasNumberedSource =
    lines.some((line) => numberedLine.test(line)) && lines.every((line) => numberedLine.test(line) || isNote(line));

  if (hasNumberedSource) {
    return lines.map((line) => {
      const match = numberedLine.exec(line);
      if (!match) return { content: line, kind: 'meta', lineNumber: null };
      return {
        content: match[2] ?? '',
        kind: 'source',
        lineNumber: Number.parseInt(match[1] ?? '1', 10)
      };
    });
  }

  const startLine = typeof offset === 'number' && Number.isInteger(offset) && offset >= 1 ? offset : 1;
  let sourceIndex = 0;
  return lines.map((content) => {
    if (isNote(content)) return { content, kind: 'meta', lineNumber: null };
    const row = { content, kind: 'source' as const, lineNumber: startLine + sourceIndex };
    sourceIndex += 1;
    return row;
  });
}

export function inferFileLanguage(path: string | undefined): FilePreviewLanguage {
  return inferCodeLanguage(path);
}

export { parseUnifiedDiff };
