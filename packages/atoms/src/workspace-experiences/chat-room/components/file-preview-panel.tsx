'use client';

import type { MessageAttachmentRef } from '@monad/protocol';
import type { CSSProperties } from 'react';
import type { BundledLanguage, BundledTheme, HighlighterGeneric, ThemedToken } from 'shiki';
import type { ChatRoomFilePreview } from '../store.ts';

import { ArrowLeft01Icon, Download04Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { isPreviewableAttachmentMime } from '@monad/protocol';
import { useDownloadAttachmentMutation, useGetAttachmentQuery } from '@monad/sdk-experience/react';
import { FileIcon } from '@monad/ui/components/FileIcon';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createHighlighter } from 'shiki';

import { workspaceExperienceT } from '../../i18n.ts';

const EXTENSION_LANGUAGES: Record<string, BundledLanguage> = {
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
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'shellscript'
};

type HighlightedFile = { background: string; foreground: string; lines: ThemedToken[][] };
export type FilePreviewLanguage = BundledLanguage | 'text';

const highlighterCache = new Map<string, Promise<HighlighterGeneric<BundledLanguage, BundledTheme>>>();
const highlightCache = new Map<string, HighlightedFile>();

export function inferPreviewLanguage(path: string): FilePreviewLanguage {
  const filename = path.split(/[?#]/, 1)[0]?.split(/[\\/]/).at(-1)?.toLowerCase() ?? '';
  if (filename === 'dockerfile') return 'dockerfile';
  if (filename === 'makefile') return 'makefile';
  const extension = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1) : '';
  return EXTENSION_LANGUAGES[extension] ?? 'text';
}

function rawHighlight(content: string): HighlightedFile {
  return {
    background: 'transparent',
    foreground: 'inherit',
    lines: content.split('\n').map((line) => (line ? [{ color: 'inherit', content: line } as ThemedToken] : []))
  };
}

async function highlightFile(content: string, language: BundledLanguage): Promise<HighlightedFile> {
  const key = `${language}:${content}`;
  const cached = highlightCache.get(key);
  if (cached) return cached;
  let highlighter = highlighterCache.get(language);
  if (!highlighter) {
    highlighter = createHighlighter({ langs: [language], themes: ['github-light', 'github-dark'] });
    highlighterCache.set(language, highlighter);
  }
  const result = (await highlighter).codeToTokens(content, {
    lang: language,
    themes: { dark: 'github-dark', light: 'github-light' }
  });
  const highlighted = {
    background: result.bg ?? 'transparent',
    foreground: result.fg ?? 'inherit',
    lines: result.tokens
  };
  highlightCache.set(key, highlighted);
  if (highlightCache.size > 50) {
    const oldest = highlightCache.keys().next().value;
    if (oldest) highlightCache.delete(oldest);
  }
  return highlighted;
}

function useHighlightedFile(content: string, language: FilePreviewLanguage): HighlightedFile {
  const key = `${language}:${content}`;
  const raw = useMemo(() => rawHighlight(content), [content]);
  const cached = highlightCache.get(key);
  const [resolved, setResolved] = useState<{ key: string; value: HighlightedFile } | null>(null);
  useEffect(() => {
    if (language === 'text') return;
    let cancelled = false;
    void highlightFile(content, language).then(
      (value) => {
        if (!cancelled) setResolved({ key, value });
      },
      () => undefined
    );
    return () => {
      cancelled = true;
    };
  }, [content, key, language]);
  if (language === 'text') return raw;
  return cached ?? (resolved?.key === key ? resolved.value : raw);
}

function HighlightedLine({ tokens }: { tokens: ThemedToken[] | undefined }): React.ReactNode {
  if (!tokens?.length) return ' ';
  const occurrences = new Map<string, number>();
  return tokens.map((token) => {
    const signature = `${token.content}:${token.color ?? ''}:${token.fontStyle ?? ''}`;
    const occurrence = occurrences.get(signature) ?? 0;
    occurrences.set(signature, occurrence + 1);
    return (
      <span
        className="dark:!bg-[var(--shiki-dark-bg)] dark:!text-[var(--shiki-dark)]"
        key={`${signature}:${occurrence}`}
        style={
          {
            backgroundColor: token.bgColor,
            color: token.color,
            // Shiki uses bit flags: 1 italic, 2 bold, 4 underline.
            // oxlint-disable-next-line eslint/no-bitwise
            fontStyle: token.fontStyle && token.fontStyle & 1 ? 'italic' : undefined,
            // oxlint-disable-next-line eslint/no-bitwise
            fontWeight: token.fontStyle && token.fontStyle & 2 ? 'bold' : undefined,
            // oxlint-disable-next-line eslint/no-bitwise
            textDecoration: token.fontStyle && token.fontStyle & 4 ? 'underline' : undefined,
            ...token.htmlStyle
          } as CSSProperties
        }
      >
        {token.content}
      </span>
    );
  });
}

export function FilePreviewContent({
  attachment,
  content,
  focusLine,
  truncated,
  truncatedLabel
}: {
  attachment: MessageAttachmentRef;
  content: string;
  focusLine?: number;
  truncated?: boolean;
  truncatedLabel: string;
}): React.ReactElement {
  const language = inferPreviewLanguage(attachment.path);
  const highlighted = useHighlightedFile(content, language);
  const lines = content.split('\n');
  const contentRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!focusLine) return;
    contentRef.current
      ?.querySelector<HTMLElement>(`[data-preview-line="${focusLine}"]`)
      ?.scrollIntoView({ block: 'center' });
  }, [focusLine]);
  return (
    <>
      <pre
        className="min-h-0 flex-1 overflow-auto font-mono text-[12px] leading-[1.55]"
        data-language={language}
        data-selectable="true"
        style={{ backgroundColor: highlighted.background, color: highlighted.foreground }}
      >
        <code ref={contentRef}>
          {lines.map((line, index) => {
            const lineNumber = index + 1;
            const focused = lineNumber === focusLine;
            return (
              <span
                className="grid w-max min-w-full grid-cols-[3.5rem_minmax(max-content,1fr)]"
                data-focus-line={focused ? 'true' : undefined}
                data-preview-line={lineNumber}
                key={`${lineNumber}:${line}`}
              >
                <span
                  aria-hidden="true"
                  className="select-none border-border/50 border-r bg-muted/30 pr-3 text-right text-muted-foreground/55"
                >
                  {lineNumber}
                </span>
                <span className={focused ? 'whitespace-pre bg-accent-blue/10 px-3' : 'whitespace-pre px-3'}>
                  <HighlightedLine tokens={highlighted.lines[index]} />
                </span>
              </span>
            );
          })}
        </code>
      </pre>
      {truncated ? (
        <div className="border-border border-t px-3 py-2 text-muted-foreground text-xs">{truncatedLabel}</div>
      ) : null}
    </>
  );
}

export function FilePreviewPanel({
  onBack,
  preview
}: {
  onBack: () => void;
  preview: ChatRoomFilePreview;
}): React.ReactElement {
  const t = workspaceExperienceT();
  const attachment = preview.attachment;
  const previewable = isPreviewableAttachmentMime(attachment.mime);
  const query = useGetAttachmentQuery({ id: attachment.id }, { skip: !previewable });
  const [downloadAttachment] = useDownloadAttachmentMutation();
  const [downloadError, setDownloadError] = useState(false);
  const download = async () => {
    setDownloadError(false);
    try {
      const { blob } = await downloadAttachment({ id: attachment.id }).unwrap();
      const blobUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = blobUrl;
      anchor.download = attachment.name;
      anchor.click();
      URL.revokeObjectURL(blobUrl);
    } catch {
      setDownloadError(true);
    }
  };
  return (
    <section
      className="flex min-h-0 flex-1 flex-col bg-sidebar"
      data-file-preview-panel="true"
    >
      <header className="flex items-center gap-2 border-sidebar-border border-b px-3 py-3">
        <button
          aria-label={t('web.workplace.attachmentCollapse')}
          className="workplace-action inline-flex size-8 items-center justify-center rounded-md border-0 bg-transparent"
          onClick={onBack}
          type="button"
        >
          <HugeiconsIcon
            icon={ArrowLeft01Icon}
            size={17}
          />
        </button>
        <FileIcon
          className="size-4 shrink-0"
          contentType={attachment.mime}
          fileName={attachment.name}
        />
        <div className="min-w-0 flex-1">
          <div
            className="truncate font-semibold text-sm"
            title={attachment.path}
          >
            {attachment.name}
          </div>
          <div
            className="truncate font-mono text-[10px] text-muted-foreground"
            title={attachment.path}
          >
            {attachment.path}
          </div>
        </div>
        <button
          aria-label={t('web.workplace.attachmentDownload')}
          className="workplace-action inline-flex size-8 items-center justify-center rounded-md border-0 bg-transparent"
          onClick={() => void download()}
          type="button"
        >
          <HugeiconsIcon
            icon={Download04Icon}
            size={17}
          />
        </button>
      </header>
      {downloadError || query.isError ? (
        <div className="p-4 text-destructive text-sm">{t('web.workplace.attachmentLoadError')}</div>
      ) : !previewable ? (
        <div className="p-4 text-muted-foreground text-sm">{t('web.workplace.attachmentPreviewUnsupported')}</div>
      ) : query.isLoading || !query.data ? (
        <div className="p-4 text-muted-foreground text-sm">...</div>
      ) : (
        <FilePreviewContent
          attachment={attachment}
          content={query.data.text}
          focusLine={preview.line}
          truncated={query.data.truncated}
          truncatedLabel={t('web.workplace.attachmentPreviewTruncated')}
        />
      )}
    </section>
  );
}
