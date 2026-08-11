import { Download04Icon, EyeIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';

import { Button } from './Button.tsx';
import { FileIcon } from './FileIcon.tsx';

export interface AttachmentCardProps {
  downloadLabel?: string;
  mime?: string;
  name: string;
  onDownload?: () => void;
  onPreview?: () => void;
  path?: string;
  previewLabel?: string;
  previewable: boolean;
  sizeLabel: string;
  tone?: 'agent' | 'human';
}

export function AttachmentCard({
  downloadLabel,
  mime,
  name,
  onDownload,
  onPreview,
  path,
  previewLabel,
  previewable,
  sizeLabel,
  tone = 'agent'
}: AttachmentCardProps) {
  const identity = (
    <>
      <FileIcon
        className="size-4 shrink-0 text-muted-foreground"
        contentType={mime}
        fileName={name}
      />
      <span
        className="min-w-0 truncate font-medium"
        title={path}
      >
        {name}
      </span>
      <span className="sr-only">{sizeLabel}</span>
    </>
  );
  if (tone === 'human') {
    const open = previewable && onPreview ? onPreview : undefined;
    return open ? (
      <button
        className="mt-2 inline-flex max-w-full items-center gap-2 rounded-full border border-border bg-muted px-3 py-2 font-sans text-[13px] text-foreground transition-[background-color,border-color] hover:border-foreground/15 hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35"
        data-attachment-card="true"
        data-attachment-tone="human"
        onClick={open}
        type="button"
      >
        {identity}
      </button>
    ) : (
      <div
        className="mt-2 inline-flex max-w-full items-center gap-2 rounded-full border border-border bg-muted px-3 py-2 font-sans text-[13px] text-foreground"
        data-attachment-card="true"
        data-attachment-tone="human"
      >
        {identity}
      </div>
    );
  }
  return (
    <div
      className="group/attachment relative mt-2 inline-flex max-w-full font-sans text-[13px] text-foreground"
      data-attachment-card="true"
      data-attachment-tone="agent"
    >
      {previewable && onPreview ? (
        <button
          className="inline-flex min-w-0 max-w-full items-center gap-2 rounded-full border border-border bg-muted px-3 py-2 transition-[background-color,border-color] hover:border-foreground/15 hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35"
          data-attachment-row="identity"
          onClick={onPreview}
          type="button"
        >
          {identity}
        </button>
      ) : (
        <div
          className="inline-flex min-w-0 max-w-full items-center gap-2 rounded-full border border-border bg-muted px-3 py-2"
          data-attachment-row="identity"
        >
          {identity}
        </div>
      )}
      <div
        className="pointer-events-none absolute top-1/2 left-full z-10 flex -translate-y-1/2 items-center gap-1 pl-1 opacity-0 transition-opacity group-focus-within/attachment:pointer-events-auto group-focus-within/attachment:opacity-100 group-hover/attachment:pointer-events-auto group-hover/attachment:opacity-100"
        data-attachment-row="actions"
      >
        {previewable && onPreview ? (
          <Button
            aria-label={previewLabel}
            className="rounded-full border border-border bg-background/90 backdrop-blur-sm"
            data-attachment-action="preview"
            onClick={onPreview}
            size="icon-sm"
            title={previewLabel}
            type="button"
            variant="ghost"
          >
            <HugeiconsIcon icon={EyeIcon} />
          </Button>
        ) : null}
        {onDownload ? (
          <Button
            aria-label={downloadLabel}
            className="rounded-full border border-border bg-background/90 backdrop-blur-sm"
            data-attachment-action="download"
            onClick={onDownload}
            size="icon-sm"
            title={downloadLabel}
            type="button"
            variant="ghost"
          >
            <HugeiconsIcon icon={Download04Icon} />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
