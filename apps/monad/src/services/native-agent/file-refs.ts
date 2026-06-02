import { fileURLToPath } from 'node:url';

export interface ParsedNativeAgentFileReferences {
  text: string;
  paths: string[];
}

const MARKER_RE = /^[ \t]*@file(?:\(([^)\r\n]+)\)|[ \t]+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s\r\n]+)))[ \t]*$/gm;
const MONAD_FILE_TITLE = 'monad:file';

export function parseNativeAgentFileReferences(text: string): ParsedNativeAgentFileReferences {
  const paths: string[] = [];
  const seen = new Set<string>();
  const codeRanges = markdownCodeRanges(text);
  const addPath = (rawPath: string): void => {
    const path = normalizeFileReferenceTarget(rawPath);
    if (!path || seen.has(path)) return;
    seen.add(path);
    paths.push(path);
  };

  for (const link of markdownLinks(text, codeRanges)) {
    if (link.title === MONAD_FILE_TITLE) addPath(link.destination);
  }

  const withoutMarkers = text.replace(MARKER_RE, (_marker, paren, doubleQuoted, singleQuoted, bare, offset) => {
    if (isInRange(offset, codeRanges)) return _marker;
    const path = String(paren ?? doubleQuoted ?? singleQuoted ?? bare ?? '').trim();
    if (!path) return _marker;
    addPath(path);
    return '';
  });

  return {
    text: withoutMarkers
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line, index, lines) => line.trim() || (index > 0 && index < lines.length - 1))
      .join('\n')
      .trim(),
    paths
  };
}

function normalizeFileReferenceTarget(rawTarget: string): string {
  const withoutFragment = rawTarget.trim().replace(/#.*$/, '');
  const unwrapped =
    withoutFragment.startsWith('<') && withoutFragment.endsWith('>') ? withoutFragment.slice(1, -1) : withoutFragment;
  if (!unwrapped) return '';
  if (/^file:/i.test(unwrapped)) {
    try {
      return fileURLToPath(unwrapped);
    } catch {
      return '';
    }
  }
  try {
    return decodeURI(unwrapped);
  } catch {
    return unwrapped;
  }
}

function markdownLinks(text: string, codeRanges: readonly TextRange[]): Array<{ destination: string; title: string }> {
  const links: Array<{ destination: string; title: string }> = [];
  for (let index = 0; index < text.length; index += 1) {
    if (isInRange(index, codeRanges)) continue;
    if (text[index] !== '[' || text[index - 1] === '!') continue;
    const labelEnd = findClosingBracket(text, index + 1);
    if (labelEnd === -1 || text[labelEnd + 1] !== '(') continue;
    const parsed = parseMarkdownLinkTarget(text, labelEnd + 2);
    if (!parsed) continue;
    links.push({ destination: parsed.destination, title: parsed.title });
    index = parsed.end;
  }
  return links;
}

function findClosingBracket(text: string, start: number): number {
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === '\\') {
      index += 1;
      continue;
    }
    if (text[index] === ']') return index;
  }
  return -1;
}

function parseMarkdownLinkTarget(
  text: string,
  start: number
): { destination: string; title: string; end: number } | null {
  let index = skipSpaces(text, start);
  const destinationStart = index;
  if (text[index] === '<') {
    index = text.indexOf('>', index + 1);
    if (index === -1) return null;
    index += 1;
  } else {
    let depth = 0;
    for (; index < text.length; index += 1) {
      const char = text[index];
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === '(') depth += 1;
      if (char === ')') {
        if (depth === 0) break;
        depth -= 1;
      }
      if (/\s/.test(char ?? '') && depth === 0) break;
    }
  }
  const destination = text.slice(destinationStart, index).trim();
  index = skipSpaces(text, index);
  if (text[index] === ')') return { destination, title: '', end: index };

  const quote = text[index];
  if (quote !== '"' && quote !== "'") return null;
  index += 1;
  const titleStart = index;
  for (; index < text.length; index += 1) {
    if (text[index] === '\\') {
      index += 1;
      continue;
    }
    if (text[index] === quote) break;
  }
  if (text[index] !== quote) return null;
  const title = text.slice(titleStart, index);
  index = skipSpaces(text, index + 1);
  if (text[index] !== ')') return null;
  return { destination, title, end: index };
}

function skipSpaces(text: string, start: number): number {
  let index = start;
  while (index < text.length && /[ \t\r\n]/.test(text[index] ?? '')) index += 1;
  return index;
}

interface TextRange {
  start: number;
  end: number;
}

function markdownCodeRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  const fenceRanges = markdownFenceRanges(text);
  ranges.push(...fenceRanges);
  ranges.push(...inlineCodeRanges(text, fenceRanges));
  return ranges.sort((a, b) => a.start - b.start);
}

function markdownFenceRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  const lines = text.matchAll(/[^\n]*(?:\n|$)/g);
  let open: { start: number; char: '`' | '~'; length: number } | null = null;
  for (const match of lines) {
    const line = match[0];
    if (!line) continue;
    const start = match.index ?? 0;
    const fence = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
    if (!fence) continue;
    const marker = fence[1] as string;
    const char = marker[0] as '`' | '~';
    if (!open) {
      open = { start, char, length: marker.length };
      continue;
    }
    if (open.char === char && marker.length >= open.length) {
      ranges.push({ start: open.start, end: start + line.length });
      open = null;
    }
  }
  if (open) ranges.push({ start: open.start, end: text.length });
  return ranges;
}

function inlineCodeRanges(text: string, fenceRanges: readonly TextRange[]): TextRange[] {
  const ranges: TextRange[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (isInRange(index, fenceRanges)) continue;
    if (text[index] !== '`') continue;
    const length = backtickRunLength(text, index);
    const close = findClosingBacktickRun(text, index + length, length, fenceRanges);
    if (close === -1) {
      index += length - 1;
      continue;
    }
    ranges.push({ start: index, end: close + length });
    index = close + length - 1;
  }
  return ranges;
}

function backtickRunLength(text: string, start: number): number {
  let length = 0;
  while (text[start + length] === '`') length += 1;
  return length;
}

function findClosingBacktickRun(
  text: string,
  start: number,
  length: number,
  fenceRanges: readonly TextRange[]
): number {
  for (let index = start; index < text.length; index += 1) {
    if (isInRange(index, fenceRanges)) continue;
    if (text[index] !== '`') continue;
    const runLength = backtickRunLength(text, index);
    if (runLength === length) return index;
    index += runLength - 1;
  }
  return -1;
}

function isInRange(index: number, ranges: readonly TextRange[]): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}
