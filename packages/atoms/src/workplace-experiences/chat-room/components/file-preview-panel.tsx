'use client';

import type { FilePreviewResource } from '@monad/protocol';
import type { CSSProperties } from 'react';
import type { BundledLanguage, BundledTheme, HighlighterGeneric, ThemedToken } from 'shiki';
import type { ChatRoomFilePreview } from '../store.ts';

import { ArrowLeft01Icon, CollapseIcon, Download04Icon, ExpandIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { isPdfAttachmentMime, isPreviewableAttachmentMime } from '@monad/protocol';
import { filePreviewUrl, useDownloadFilePreviewMutation, useGetFilePreviewQuery } from '@monad/sdk-experience/react';
import { Button, ImageGalleryDialog } from '@monad/ui';
import { FileIcon } from '@monad/ui/components/FileIcon';
import { Markdown } from '@monad/ui/components/Markdown';
import { SHIKI_THEME_NAMES, SHIKI_THEMES } from '@monad/ui/lib/shiki';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createHighlighter } from 'shiki';

import { workplaceExperienceT } from '../../i18n.ts';

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
export type RenderedFilePreviewKind = 'html' | 'markdown';

const highlighterCache = new Map<string, Promise<HighlighterGeneric<BundledLanguage, BundledTheme>>>();
const highlightCache = new Map<string, HighlightedFile>();

export function inferPreviewLanguage(path: string): FilePreviewLanguage {
  const filename = path.split(/[?#]/, 1)[0]?.split(/[\\/]/).at(-1)?.toLowerCase() ?? '';
  if (filename === 'dockerfile') return 'dockerfile';
  if (filename === 'makefile') return 'makefile';
  const extension = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1) : '';
  return EXTENSION_LANGUAGES[extension] ?? 'text';
}

export function renderedFilePreviewKind(
  attachment: Pick<FilePreviewResource, 'mime' | 'path'>
): RenderedFilePreviewKind | null {
  const mime = attachment.mime.split(';', 1)[0]?.trim().toLowerCase();
  if (mime === 'text/html') return 'html';
  if (mime === 'text/markdown') return 'markdown';
  const extension = attachment.path
    .split(/[?#]/, 1)[0]
    ?.toLowerCase()
    .match(/\.([^.\\/]+)$/)?.[1];
  if (extension === 'html' || extension === 'htm') return 'html';
  if (extension === 'md' || extension === 'markdown') return 'markdown';
  return null;
}

export function sandboxedHtml(content: string): string {
  const policy =
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: blob:; media-src data: blob:; font-src data:; style-src \'unsafe-inline\';">';
  return `<!doctype html><html><head>${policy}</head><body>${content}</body></html>`;
}

function RenderedFilePreview({
  attachment,
  content,
  kind,
  title
}: {
  attachment: FilePreviewResource;
  content: string;
  kind: RenderedFilePreviewKind;
  title: string;
}): React.ReactElement {
  if (kind === 'html') {
    return (
      <iframe
        className="min-h-0 flex-1 border-0 bg-background"
        data-rendered-file-preview="html"
        referrerPolicy="no-referrer"
        sandbox=""
        srcDoc={sandboxedHtml(content)}
        title={`${attachment.name} · ${title}`}
      />
    );
  }
  return (
    <div
      className="min-h-0 flex-1 overflow-auto bg-background p-5"
      data-rendered-file-preview="markdown"
    >
      <Markdown text={content} />
    </div>
  );
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
    highlighter = createHighlighter({ langs: [language], themes: SHIKI_THEME_NAMES });
    highlighterCache.set(language, highlighter);
  }
  const result = (await highlighter).codeToTokens(content, {
    lang: language,
    themes: SHIKI_THEMES
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

function FilePreviewContent({
  attachment,
  content,
  focusLine,
  truncated,
  truncatedLabel
}: {
  attachment: FilePreviewResource;
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
        className="min-h-0 flex-1 overflow-auto font-code text-[12px] leading-[1.55]"
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
  const t = workplaceExperienceT();
  const gallery = useMemo(() => {
    const images = (preview.gallery ?? []).filter((item) => item.mime.startsWith('image/'));
    if (!preview.attachment) return images;
    return images.some((item) => item.id === preview.attachment?.id) ? images : [preview.attachment, ...images];
  }, [preview.attachment, preview.gallery]);
  const initialIndex = Math.max(
    0,
    gallery.findIndex((item) => item.id === preview.attachment?.id)
  );
  const [galleryIndex, setGalleryIndex] = useState(initialIndex);
  useEffect(() => setGalleryIndex(initialIndex), [initialIndex]);
  const galleryAttachment = gallery[galleryIndex] ?? preview.attachment;
  const target = galleryAttachment ? { attachmentId: galleryAttachment.id } : preview.target;
  const targetKey = 'attachmentId' in target ? target.attachmentId : target.path;
  const query = useGetFilePreviewQuery(target);
  const fallbackPath = 'path' in target ? target.path : (galleryAttachment?.path ?? target.attachmentId);
  const resource: FilePreviewResource = query.data?.resource ?? {
    path: fallbackPath,
    name: galleryAttachment?.name ?? fallbackPath.split(/[\\/]/).at(-1) ?? fallbackPath,
    mime: galleryAttachment?.mime ?? 'application/octet-stream',
    bytes: galleryAttachment?.bytes ?? 0
  };
  const image = resource.mime.startsWith('image/');
  const pdf = isPdfAttachmentMime(resource.mime);
  const previewable = image || pdf || isPreviewableAttachmentMime(resource.mime);
  const [downloadFilePreview] = useDownloadFilePreviewMutation();
  const [downloadError, setDownloadError] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [viewState, setViewState] = useState<{ targetKey: string; mode: 'preview' | 'source' }>({
    targetKey,
    mode: 'source'
  });
  const viewMode = viewState.targetKey === targetKey ? viewState.mode : 'source';
  const renderedKind = renderedFilePreviewKind(resource);
  useEffect(() => {
    if (!fullscreen) return;
    const exitFullscreen = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', exitFullscreen);
    return () => window.removeEventListener('keydown', exitFullscreen);
  }, [fullscreen]);
  const download = async () => {
    setDownloadError(false);
    try {
      const { blob } = await downloadFilePreview(target).unwrap();
      const blobUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = blobUrl;
      anchor.download = resource.name;
      anchor.click();
      URL.revokeObjectURL(blobUrl);
    } catch {
      setDownloadError(true);
    }
  };
  if (image && query.data) {
    const slides = gallery.length
      ? gallery.map((item) => ({ alt: item.name, src: filePreviewUrl({ attachmentId: item.id }, 'download') }))
      : [{ alt: resource.name, src: filePreviewUrl(target, 'download') }];
    return (
      <ImageGalleryDialog
        index={galleryIndex}
        labels={{
          close: t('web.workplace.imagePreviewClose'),
          next: t('web.workplace.imagePreviewNext'),
          previous: t('web.workplace.imagePreviewPrevious'),
          zoomIn: t('web.workplace.imagePreviewZoomIn'),
          zoomOut: t('web.workplace.imagePreviewZoomOut')
        }}
        onClose={onBack}
        onIndexChange={setGalleryIndex}
        open
        slides={slides}
      />
    );
  }
  const panel = (
    <section
      className={
        fullscreen ? 'fixed inset-0 z-50 flex min-h-0 flex-col bg-sidebar' : 'flex min-h-0 flex-1 flex-col bg-sidebar'
      }
      data-file-preview-panel="true"
      data-fullscreen={fullscreen ? 'true' : 'false'}
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
          contentType={resource.mime}
          fileName={resource.name}
        />
        <div className="min-w-0 flex-1">
          <div
            className="truncate font-semibold text-sm"
            title={resource.path}
          >
            {resource.name}
          </div>
          <div
            className="truncate font-ui text-[10px] text-muted-foreground"
            title={attachment.path}
          >
            {resource.path}
          </div>
        </div>
        {renderedKind ? (
          <Button
            aria-label={t(
              viewMode === 'source' ? 'web.workplace.attachmentRenderPreview' : 'web.workplace.attachmentViewSource'
            )}
            data-file-view-mode={viewMode}
            onClick={() =>
              setViewState({
                targetKey,
                mode: viewMode === 'source' ? 'preview' : 'source'
              })
            }
            size="xs"
            type="button"
            variant="ghost"
          >
            {t(viewMode === 'source' ? 'web.workplace.attachmentRenderPreview' : 'web.workplace.attachmentViewSource')}
          </Button>
        ) : null}
        <button
          aria-label={t(
            fullscreen ? 'web.workplace.attachmentExitFullscreen' : 'web.workplace.attachmentEnterFullscreen'
          )}
          className="workplace-action inline-flex size-8 items-center justify-center rounded-md border-0 bg-transparent"
          onClick={() => setFullscreen((current) => !current)}
          type="button"
        >
          <HugeiconsIcon
            icon={fullscreen ? CollapseIcon : ExpandIcon}
            size={17}
          />
        </button>
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
      ) : query.isLoading || !query.data ? (
        <div className="p-4 text-muted-foreground text-sm">...</div>
      ) : pdf ? (
        <iframe
          className="min-h-0 flex-1 border-0 bg-background"
          data-pdf-preview="true"
          referrerPolicy="no-referrer"
          src={filePreviewUrl(target, 'inline')}
          title={`${resource.name} · ${t('web.workplace.attachmentPreview')}`}
        />
      ) : !previewable ? (
        <div className="p-4 text-muted-foreground text-sm">{t('web.workplace.attachmentPreviewUnsupported')}</div>
      ) : renderedKind && viewMode === 'preview' ? (
        <>
          <RenderedFilePreview
            attachment={resource}
            content={query.data.text}
            kind={renderedKind}
            title={t('web.workplace.attachmentRenderPreview')}
          />
          {query.data.truncated ? (
            <div className="border-border border-t px-3 py-2 text-muted-foreground text-xs">
              {t('web.workplace.attachmentPreviewTruncated')}
            </div>
          ) : null}
        </>
      ) : (
        <FilePreviewContent
          attachment={resource}
          content={query.data.text}
          focusLine={preview.line}
          truncated={query.data.truncated}
          truncatedLabel={t('web.workplace.attachmentPreviewTruncated')}
        />
      )}
    </section>
  );
  return fullscreen && typeof document !== 'undefined' ? createPortal(panel, document.body) : panel;
}
