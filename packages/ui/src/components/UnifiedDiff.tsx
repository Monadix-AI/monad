import type { CSSProperties } from 'react';
import type { BundledLanguage, BundledTheme, HighlighterGeneric, ThemedToken } from 'shiki';

import { useEffect, useMemo, useState } from 'react';
import { createHighlighter } from 'shiki';

import { SHIKI_THEME_NAMES, SHIKI_THEMES } from '../lib/shiki';
import { cn } from '../lib/utils';
import { FileIcon } from './FileIcon';
import {
  type CodeLanguage,
  type DiffHighlightRange,
  inferCodeLanguage,
  parseUnifiedDiff,
  type UnifiedDiffRow
} from './unified-diff-model';

export interface UnifiedDiffProps {
  added?: number;
  className?: string;
  diff: string;
  path: string;
  removed?: number;
  showHeader?: boolean;
  /** Off for a diff synthesized from a tool call that never reported where in the file it applied:
   *  the hunk positions would be invented, so the gutter stays blank instead of claiming line 1. */
  showLineNumbers?: boolean;
  warning?: string;
}

interface HighlightedCode {
  background: string;
  foreground: string;
  lines: ThemedToken[][];
}

const highlighterCache = new Map<string, Promise<HighlighterGeneric<BundledLanguage, BundledTheme>>>();
const highlightedCodeCache = new Map<string, HighlightedCode>();

export function UnifiedDiff({
  added,
  className,
  diff,
  path,
  removed,
  showHeader = true,
  showLineNumbers = true,
  warning
}: UnifiedDiffProps): React.ReactElement {
  const rows = useMemo(() => {
    const parsed = parseUnifiedDiff(diff);
    return showLineNumbers ? parsed : parsed.filter((row) => row.kind !== 'hunk');
  }, [diff, showLineNumbers]);
  const language = inferCodeLanguage(path);
  const syntaxCode = useMemo(() => rows.map((row) => row.code).join('\n'), [rows]);
  const highlighted = useHighlightedCode(syntaxCode, language);
  const additions = added ?? rows.filter((row) => row.kind === 'addition').length;
  const deletions = removed ?? rows.filter((row) => row.kind === 'deletion').length;

  return (
    <div
      className={cn('overflow-hidden rounded-md border border-border/70 bg-background', className)}
      data-language={language}
      data-unified-diff="true"
    >
      {showHeader ? (
        <FileHeader
          added={additions}
          path={path}
          removed={deletions}
          warning={warning}
        />
      ) : null}
      {warning ? (
        <div className="border-warning/20 border-b bg-warning/5 px-3 py-2 text-[11px] text-warning">{warning}</div>
      ) : null}
      <pre
        className="max-h-80 overflow-auto font-mono text-[12px] leading-[1.55]"
        data-selectable="true"
        style={{ backgroundColor: highlighted.background, color: highlighted.foreground }}
      >
        <code className="block w-max min-w-full">
          {rows.map((row, index) => (
            <DiffLine
              highlightedLine={highlighted.lines[index]}
              key={row.key}
              row={row}
              showLineNumbers={showLineNumbers}
            />
          ))}
        </code>
      </pre>
    </div>
  );
}

function DiffLine({
  row,
  highlightedLine,
  showLineNumbers
}: {
  row: UnifiedDiffRow;
  highlightedLine: ThemedToken[] | undefined;
  showLineNumbers: boolean;
}) {
  const showSyntax = row.kind === 'addition' || row.kind === 'context' || row.kind === 'deletion';
  return (
    <span
      className={cn(
        'grid min-w-full grid-cols-[3.25rem_1.5rem_minmax(max-content,1fr)]',
        row.kind === 'addition' && 'bg-emerald-500/10',
        row.kind === 'deletion' && 'bg-red-500/10',
        row.kind === 'hunk' && 'bg-info/5 text-info',
        row.kind === 'meta' && 'text-muted-foreground'
      )}
      data-kind={row.kind}
      data-new-line={row.newLine ?? undefined}
      data-old-line={row.oldLine ?? undefined}
    >
      <span
        aria-hidden="true"
        className={cn(
          'select-none pr-3 text-right text-muted-foreground/60',
          row.kind === 'addition' && 'text-emerald-700/75 dark:text-emerald-300/75',
          row.kind === 'deletion' && 'text-red-700/75 dark:text-red-300/75'
        )}
      >
        {showLineNumbers ? (row.newLine ?? row.oldLine ?? ' ') : ' '}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          'select-none text-center text-muted-foreground/45',
          row.kind === 'addition' && 'text-emerald-700 dark:text-emerald-300',
          row.kind === 'deletion' && 'text-red-700 dark:text-red-300'
        )}
      >
        {row.marker}
      </span>
      <span className="whitespace-pre pr-3">
        {showSyntax ? (
          <HighlightedLine
            changedRanges={row.changedRanges}
            kind={row.kind}
            line={highlightedLine}
            rowKey={row.key}
          />
        ) : (
          row.content || ' '
        )}
      </span>
    </span>
  );
}

function HighlightedLine({
  changedRanges,
  kind,
  line,
  rowKey
}: {
  changedRanges: DiffHighlightRange[] | undefined;
  kind: UnifiedDiffRow['kind'];
  line: ThemedToken[] | undefined;
  rowKey: string;
}) {
  if (!line || line.length === 0) return ' ';
  let offset = 0;
  return line.flatMap((token) => {
    const tokenOffset = offset;
    const segments = splitToken(token, offset, changedRanges);
    offset += token.content.length;
    return segments.map((segment) => (
      <Token
        emphasized={segment.emphasized}
        key={`${rowKey}-${tokenOffset + segment.start}`}
        kind={kind}
        text={segment.text}
        token={token}
      />
    ));
  });
}

function Token({
  emphasized,
  kind,
  text,
  token
}: {
  emphasized: boolean;
  kind: UnifiedDiffRow['kind'];
  text: string;
  token: ThemedToken;
}) {
  const fontStyle = token.fontStyle ?? 0;
  return (
    <span
      className={cn(
        'dark:!bg-[var(--shiki-dark-bg)] dark:!text-[var(--shiki-dark)]',
        emphasized && kind === 'addition' && 'dark:!bg-emerald-400/20 rounded-sm bg-emerald-500/20',
        emphasized && kind === 'deletion' && 'dark:!bg-red-400/20 rounded-sm bg-red-500/20'
      )}
      style={
        {
          backgroundColor: emphasized ? undefined : token.bgColor,
          color: token.color,
          fontStyle: [1, 3, 5, 7].includes(fontStyle) ? 'italic' : undefined,
          fontWeight: [2, 3, 6, 7].includes(fontStyle) ? 'bold' : undefined,
          textDecoration: fontStyle >= 4 ? 'underline' : undefined,
          ...token.htmlStyle
        } as CSSProperties
      }
    >
      {text}
    </span>
  );
}

function splitToken(
  token: ThemedToken,
  offset: number,
  ranges: DiffHighlightRange[] | undefined
): Array<{ emphasized: boolean; start: number; text: string }> {
  if (!ranges || ranges.length === 0) return [{ emphasized: false, start: 0, text: token.content }];
  const boundaries = new Set([0, token.content.length]);
  const tokenEnd = offset + token.content.length;
  for (const range of ranges) {
    if (range.end <= offset || range.start >= tokenEnd) continue;
    boundaries.add(Math.max(0, range.start - offset));
    boundaries.add(Math.min(token.content.length, range.end - offset));
  }
  const sorted = [...boundaries].sort((left, right) => left - right);
  return sorted.slice(0, -1).flatMap((start, index) => {
    const end = sorted[index + 1] ?? start;
    const text = token.content.slice(start, end);
    if (!text) return [];
    const absoluteStart = offset + start;
    return [
      {
        emphasized: ranges.some((range) => absoluteStart >= range.start && absoluteStart < range.end),
        start,
        text
      }
    ];
  });
}

function FileHeader({
  path,
  added,
  removed,
  warning
}: {
  path: string;
  added: number;
  removed: number;
  warning?: string;
}) {
  return (
    <div className="flex items-center gap-2 border-border/70 border-b bg-muted/50 px-3 py-2 text-muted-foreground text-xs">
      <FileIcon
        className="size-3.5"
        fileName={path}
      />
      <span className="min-w-0 truncate font-mono">{path}</span>
      {warning ? (
        <span className="shrink-0 rounded bg-warning/10 px-1.5 py-0.5 font-mono text-[10px] text-warning">warning</span>
      ) : null}
      <span className="ml-auto shrink-0 font-mono text-[11px]">
        <span className="text-success">+{added}</span>
        <span className="ml-2 text-destructive">-{removed}</span>
      </span>
    </div>
  );
}

function rawHighlightedCode(code: string): HighlightedCode {
  return {
    background: 'transparent',
    foreground: 'inherit',
    lines: code.split('\n').map((line) => (line ? [{ color: 'inherit', content: line } as ThemedToken] : []))
  };
}

async function highlight(code: string, language: BundledLanguage): Promise<HighlightedCode> {
  const key = `${language}:${code}`;
  const cached = highlightedCodeCache.get(key);
  if (cached) return cached;
  let highlighterPromise = highlighterCache.get(language);
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({ langs: [language], themes: SHIKI_THEME_NAMES });
    highlighterCache.set(language, highlighterPromise);
  }
  const highlighter = await highlighterPromise;
  const result = highlighter.codeToTokens(code, {
    lang: language,
    themes: SHIKI_THEMES
  });
  const highlighted = {
    background: result.bg ?? 'transparent',
    foreground: result.fg ?? 'inherit',
    lines: result.tokens
  };
  highlightedCodeCache.set(key, highlighted);
  if (highlightedCodeCache.size > 100) {
    const oldestKey = highlightedCodeCache.keys().next().value;
    if (oldestKey) highlightedCodeCache.delete(oldestKey);
  }
  return highlighted;
}

function useHighlightedCode(code: string, language: CodeLanguage): HighlightedCode {
  const key = `${language}:${code}`;
  const raw = useMemo(() => rawHighlightedCode(code), [code]);
  const cached = highlightedCodeCache.get(key);
  const [resolved, setResolved] = useState<{ key: string; value: HighlightedCode } | null>(null);

  useEffect(() => {
    if (language === 'text') return;
    let cancelled = false;
    void highlight(code, language).then(
      (value) => {
        if (!cancelled) setResolved({ key, value });
      },
      () => undefined
    );
    return () => {
      cancelled = true;
    };
  }, [code, key, language]);

  if (language === 'text') return raw;
  if (cached) return cached;
  return resolved?.key === key ? resolved.value : raw;
}
