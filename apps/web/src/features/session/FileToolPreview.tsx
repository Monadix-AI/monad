import type { CSSProperties } from 'react';
import type { BundledLanguage, BundledTheme, HighlighterGeneric, ThemedToken } from 'shiki';

import { TextIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { cn } from '@monad/ui';
import { useEffect, useMemo, useState } from 'react';
import { createHighlighter } from 'shiki';

import {
  buildFileReadRows,
  type FilePreviewLanguage,
  inferFileLanguage,
  parseUnifiedDiff,
  type UnifiedDiffRow
} from './file-tool-preview-model';

export interface FileDiffPreviewDisplay {
  type: 'diff';
  path: string;
  beforeText: string | null;
  afterText: string;
  diff?: string;
  diffStat?: { added: number; removed: number };
  warning?: string;
}

interface HighlightedCode {
  background: string;
  foreground: string;
  lines: ThemedToken[][];
}

const highlighterCache = new Map<string, Promise<HighlighterGeneric<BundledLanguage, BundledTheme>>>();
const highlightedCodeCache = new Map<string, HighlightedCode>();

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
    highlighterPromise = createHighlighter({ langs: [language], themes: ['github-light', 'github-dark'] });
    highlighterCache.set(language, highlighterPromise);
  }

  const highlighter = await highlighterPromise;
  const result = highlighter.codeToTokens(code, {
    lang: language,
    themes: { dark: 'github-dark', light: 'github-light' }
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

function useHighlightedCode(code: string, language: FilePreviewLanguage): HighlightedCode {
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

function Token({ token }: { token: ThemedToken }) {
  const fontStyle = token.fontStyle ?? 0;
  return (
    <span
      className="dark:!bg-[var(--shiki-dark-bg)] dark:!text-[var(--shiki-dark)]"
      style={
        {
          backgroundColor: token.bgColor,
          color: token.color,
          fontStyle: [1, 3, 5, 7].includes(fontStyle) ? 'italic' : undefined,
          fontWeight: [2, 3, 6, 7].includes(fontStyle) ? 'bold' : undefined,
          textDecoration: fontStyle >= 4 ? 'underline' : undefined,
          ...token.htmlStyle
        } as CSSProperties
      }
    >
      {token.content}
    </span>
  );
}

function HighlightedLine({ line, rowKey }: { line: ThemedToken[] | undefined; rowKey: string }) {
  if (!line || line.length === 0) return ' ';
  const occurrences = new Map<string, number>();
  return line.map((token) => {
    const occurrence = occurrences.get(token.content) ?? 0;
    occurrences.set(token.content, occurrence + 1);
    return (
      <Token
        key={`${rowKey}-${token.content}-${occurrence}`}
        token={token}
      />
    );
  });
}

export function FileReadPreview({ output, path, offset }: { output: string; path?: string; offset?: number }) {
  const rows = useMemo(() => buildFileReadRows(output, offset), [offset, output]);
  const language = inferFileLanguage(path);
  const code = useMemo(() => rows.map((row) => row.content).join('\n'), [rows]);
  const highlighted = useHighlightedCode(code, language);

  return (
    <div
      className="overflow-hidden rounded-md border border-border/70 bg-background"
      data-language={language}
    >
      <FileHeader path={path ?? 'file'} />
      <pre
        className="max-h-80 overflow-auto font-mono text-[12px] leading-[1.5]"
        data-selectable="true"
        style={{ backgroundColor: highlighted.background, color: highlighted.foreground }}
      >
        <code>
          {rows.map((row, index) => (
            <span
              className={cn(
                'grid w-max min-w-full grid-cols-[3.5rem_minmax(max-content,1fr)]',
                row.kind === 'meta' && 'bg-muted/25 text-muted-foreground'
              )}
              key={`${row.kind}-${row.lineNumber ?? row.content}`}
            >
              <span
                aria-hidden="true"
                className="select-none border-border/50 border-r bg-muted/30 pr-3 text-right text-muted-foreground/55"
                data-line-number={row.lineNumber ?? undefined}
              >
                {row.lineNumber ?? ' '}
              </span>
              <span className="whitespace-pre px-3">
                {row.kind === 'source' ? (
                  <HighlightedLine
                    line={highlighted.lines[index]}
                    rowKey={`read-${row.lineNumber}`}
                  />
                ) : (
                  row.content
                )}
              </span>
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

export function UnifiedDiffPreview({ display }: { display: FileDiffPreviewDisplay }) {
  const diff = display.diff ?? display.afterText;
  const rows = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const language = inferFileLanguage(display.path);
  const syntaxCode = useMemo(() => rows.map((row) => row.code).join('\n'), [rows]);
  const highlighted = useHighlightedCode(syntaxCode, language);
  const added = display.diffStat?.added ?? rows.filter((row) => row.kind === 'addition').length;
  const removed = display.diffStat?.removed ?? rows.filter((row) => row.kind === 'deletion').length;

  return (
    <div
      className="overflow-hidden rounded-md border border-border/70 bg-background"
      data-language={language}
    >
      <FileHeader
        added={added}
        path={display.path}
        removed={removed}
        warning={display.warning}
      />
      {display.warning && (
        <div className="border-warning/20 border-b bg-warning/5 px-3 py-2 text-[11px] text-warning">
          {display.warning}
        </div>
      )}
      <pre
        className="max-h-80 overflow-auto font-mono text-[12px] leading-[1.5]"
        data-selectable="true"
      >
        <code>
          {rows.map((row, index) => (
            <DiffLine
              highlightedLine={highlighted.lines[index]}
              key={row.key}
              row={row}
            />
          ))}
        </code>
      </pre>
    </div>
  );
}

function DiffLine({ row, highlightedLine }: { row: UnifiedDiffRow; highlightedLine: ThemedToken[] | undefined }) {
  const showSyntax = row.kind === 'addition' || row.kind === 'context' || row.kind === 'deletion';
  return (
    <span
      className={cn(
        'grid w-max min-w-full grid-cols-[3.25rem_3.25rem_minmax(max-content,1fr)]',
        row.kind === 'addition' && 'bg-emerald-500/10',
        row.kind === 'deletion' && 'bg-red-500/10',
        row.kind === 'hunk' && 'bg-info/5 text-info',
        row.kind === 'meta' && 'text-muted-foreground'
      )}
      data-kind={row.kind}
      data-new-line={row.newLine ?? undefined}
      data-old-line={row.oldLine ?? undefined}
    >
      <DiffGutter value={row.oldLine} />
      <DiffGutter
        bordered
        value={row.newLine}
      />
      <span className="whitespace-pre px-3">
        {row.marker && (
          <span
            className={cn(
              row.kind === 'addition' && 'text-emerald-700 dark:text-emerald-300',
              row.kind === 'deletion' && 'text-red-700 dark:text-red-300',
              row.kind === 'context' && 'text-muted-foreground/50'
            )}
          >
            {row.marker}
          </span>
        )}
        {showSyntax ? (
          <HighlightedLine
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

function DiffGutter({ value, bordered = false }: { value: number | null; bordered?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'select-none bg-muted/25 pr-2 text-right text-muted-foreground/50',
        bordered && 'border-border/50 border-r'
      )}
    >
      {value ?? ' '}
    </span>
  );
}

function FileHeader({
  path,
  added,
  removed,
  warning
}: {
  path: string;
  added?: number;
  removed?: number;
  warning?: string;
}) {
  return (
    <div className="flex items-center gap-2 border-border/70 border-b bg-muted/50 px-3 py-2 text-muted-foreground text-xs">
      <HugeiconsIcon
        className="size-3.5"
        icon={TextIcon}
      />
      <span className="min-w-0 truncate font-mono">{path}</span>
      {warning && (
        <span className="shrink-0 rounded bg-warning/10 px-1.5 py-0.5 font-mono text-[10px] text-warning">warning</span>
      )}
      {added !== undefined && removed !== undefined && (
        <span className="ml-auto shrink-0 font-mono text-[11px]">
          <span className="text-emerald-500">+{added}</span>
          <span className="mx-1 text-muted-foreground/50">/</span>
          <span className="text-red-500">-{removed}</span>
        </span>
      )}
    </div>
  );
}
