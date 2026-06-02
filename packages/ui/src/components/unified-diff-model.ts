import type { BundledLanguage } from 'shiki';

export type CodeLanguage = BundledLanguage | 'text';

export interface DiffHighlightRange {
  end: number;
  start: number;
}

export type UnifiedDiffRowKind = 'addition' | 'context' | 'deletion' | 'hunk' | 'meta';

export interface UnifiedDiffRow {
  changedRanges?: DiffHighlightRange[];
  code: string;
  content: string;
  key: string;
  kind: UnifiedDiffRowKind;
  marker: '' | ' ' | '+' | '-';
  newLine: number | null;
  oldLine: number | null;
}

const EXTENSION_LANGUAGES: Record<string, CodeLanguage> = {
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

type DiffToken = {
  end: number;
  start: number;
  value: string;
};

export function inferCodeLanguage(path: string | undefined): CodeLanguage {
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
  const rows = splitVisibleLines(diff).map((content, index) => {
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
  addIntralineHighlights(rows);
  return rows;
}

function splitVisibleLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
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

function addIntralineHighlights(rows: UnifiedDiffRow[]): void {
  let index = 0;
  while (index < rows.length) {
    if (rows[index]?.kind !== 'deletion') {
      index += 1;
      continue;
    }
    const deletions: UnifiedDiffRow[] = [];
    while (rows[index]?.kind === 'deletion') {
      const row = rows[index];
      if (row) deletions.push(row);
      index += 1;
    }
    const additions: UnifiedDiffRow[] = [];
    while (rows[index]?.kind === 'addition') {
      const row = rows[index];
      if (row) additions.push(row);
      index += 1;
    }
    const pairCount = Math.min(deletions.length, additions.length);
    for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
      const deletion = deletions[pairIndex];
      const addition = additions[pairIndex];
      if (!deletion || !addition) continue;
      const ranges = changedTokenRanges(deletion.code, addition.code);
      if (ranges.before.length > 0) deletion.changedRanges = ranges.before;
      if (ranges.after.length > 0) addition.changedRanges = ranges.after;
    }
  }
}

function changedTokenRanges(
  before: string,
  after: string
): {
  after: DiffHighlightRange[];
  before: DiffHighlightRange[];
} {
  const beforeTokens = tokens(before);
  const afterTokens = tokens(after);
  if (beforeTokens.length * afterTokens.length > 4096) {
    return {
      after: edgeRange(before, after, after.length),
      before: edgeRange(before, after, before.length)
    };
  }

  const matrix = Array.from({ length: beforeTokens.length + 1 }, () => new Uint16Array(afterTokens.length + 1));
  for (let beforeIndex = beforeTokens.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = afterTokens.length - 1; afterIndex >= 0; afterIndex -= 1) {
      const row = matrix[beforeIndex];
      if (!row) continue;
      row[afterIndex] =
        beforeTokens[beforeIndex]?.value === afterTokens[afterIndex]?.value
          ? (matrix[beforeIndex + 1]?.[afterIndex + 1] ?? 0) + 1
          : Math.max(matrix[beforeIndex + 1]?.[afterIndex] ?? 0, matrix[beforeIndex]?.[afterIndex + 1] ?? 0);
    }
  }

  const matchedBefore = new Set<number>();
  const matchedAfter = new Set<number>();
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < beforeTokens.length && afterIndex < afterTokens.length) {
    if (beforeTokens[beforeIndex]?.value === afterTokens[afterIndex]?.value) {
      matchedBefore.add(beforeIndex);
      matchedAfter.add(afterIndex);
      beforeIndex += 1;
      afterIndex += 1;
    } else if ((matrix[beforeIndex + 1]?.[afterIndex] ?? 0) >= (matrix[beforeIndex]?.[afterIndex + 1] ?? 0)) {
      beforeIndex += 1;
    } else {
      afterIndex += 1;
    }
  }

  return {
    after: unmatchedRanges(after, afterTokens, matchedAfter),
    before: unmatchedRanges(before, beforeTokens, matchedBefore)
  };
}

function tokens(value: string): DiffToken[] {
  const result: DiffToken[] = [];
  for (const match of value.matchAll(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]+/gu)) {
    const start = match.index;
    const token = match[0];
    result.push({ end: start + token.length, start, value: token });
  }
  return result;
}

function unmatchedRanges(value: string, tokensToCheck: DiffToken[], matched: Set<number>): DiffHighlightRange[] {
  const ranges: DiffHighlightRange[] = [];
  for (let index = 0; index < tokensToCheck.length; index += 1) {
    if (matched.has(index)) continue;
    const token = tokensToCheck[index];
    if (!token) continue;
    const previous = ranges.at(-1);
    if (previous && /^\s*$/.test(value.slice(previous.end, token.start))) previous.end = token.end;
    else ranges.push({ end: token.end, start: token.start });
  }
  return ranges;
}

function edgeRange(before: string, after: string, length: number): DiffHighlightRange[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  const end = length === before.length ? beforeEnd : afterEnd;
  return end > start ? [{ end, start }] : [];
}
