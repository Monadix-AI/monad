import type { BundledLanguage } from 'shiki';

export interface FileReadRow {
  content: string;
  kind: 'meta' | 'source';
  lineNumber: number | null;
}

export type FilePreviewLanguage = BundledLanguage | 'text';

type UnifiedDiffRowKind = 'addition' | 'context' | 'deletion' | 'hunk' | 'meta';

export interface UnifiedDiffRow {
  code: string;
  content: string;
  key: string;
  kind: UnifiedDiffRowKind;
  marker: '' | ' ' | '+' | '-';
  newLine: number | null;
  oldLine: number | null;
}

const EXTENSION_LANGUAGES: Record<string, FilePreviewLanguage> = {
  bash: 'bash',
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  css: 'css',
  go: 'go',
  h: 'c',
  hpp: 'cpp',
  html: 'html',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'jsx',
  md: 'markdown',
  mdx: 'mdx',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'shellscript',
  sql: 'sql',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'tsx',
  txt: 'text',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'shellscript'
};

const FILENAME_LANGUAGES: Record<string, BundledLanguage> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile'
};

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
  if (!path) return 'text';
  const cleanPath = path.split(/[?#]/, 1)[0] ?? path;
  const filename = cleanPath.split(/[\\/]/).at(-1)?.toLowerCase() ?? '';
  const knownFilename = FILENAME_LANGUAGES[filename];
  if (knownFilename) return knownFilename;
  const extension = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1) : '';
  return EXTENSION_LANGUAGES[extension] ?? 'text';
}

export function parseUnifiedDiff(diff: string): UnifiedDiffRow[] {
  let oldLine: number | null = null;
  let newLine: number | null = null;

  return splitVisibleLines(diff).map((content, index) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(content);
    if (hunk) {
      oldLine = Number.parseInt(hunk[1] ?? '0', 10);
      newLine = Number.parseInt(hunk[2] ?? '0', 10);
      return diffRow(content, index, 'hunk', '', null, null);
    }

    if (oldLine !== null && newLine !== null && content.startsWith('+') && !content.startsWith('+++')) {
      const row = diffRow(content, index, 'addition', '+', null, newLine);
      newLine += 1;
      return row;
    }

    if (oldLine !== null && newLine !== null && content.startsWith('-') && !content.startsWith('---')) {
      const row = diffRow(content, index, 'deletion', '-', oldLine, null);
      oldLine += 1;
      return row;
    }

    if (oldLine !== null && newLine !== null && content.startsWith(' ')) {
      const row = diffRow(content, index, 'context', ' ', oldLine, newLine);
      oldLine += 1;
      newLine += 1;
      return row;
    }

    return diffRow(content, index, 'meta', '', null, null);
  });
}

function diffRow(
  content: string,
  index: number,
  kind: UnifiedDiffRowKind,
  marker: UnifiedDiffRow['marker'],
  oldLine: number | null,
  newLine: number | null
): UnifiedDiffRow {
  return {
    code: marker ? content.slice(1) : content,
    content,
    key: `${index}-${kind}-${oldLine ?? ''}-${newLine ?? ''}`,
    kind,
    marker,
    newLine,
    oldLine
  };
}
