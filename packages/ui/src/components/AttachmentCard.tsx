import { Download04Icon, EyeIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';

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
  sizeLabel
}: AttachmentCardProps) {
  return (
    <div
      className="mt-2 rounded-lg border border-border bg-card px-2.5 py-2 font-sans text-[13px] text-foreground"
      data-attachment-card="true"
    >
      <div
        className="flex min-w-0 items-center gap-2"
        data-attachment-row="identity"
      >
        <FileIcon
          className="size-4 shrink-0 text-muted-foreground"
          contentType={mime}
          fileName={name}
        />
        <span
          className="min-w-0 truncate font-semibold"
          title={path}
        >
          {name}
        </span>
      </div>
      <div
        className="mt-1.5 flex min-w-0 items-center gap-2 pl-6"
        data-attachment-row="actions"
      >
        <span className="font-mono text-[11px] text-muted-foreground">{sizeLabel}</span>
        {previewable && onPreview ? (
          <button
            className="inline-flex items-center gap-1 border-0 bg-transparent p-0 font-sans text-accent-blue text-xs"
            onClick={onPreview}
            type="button"
          >
            <HugeiconsIcon
              icon={EyeIcon}
              size={13}
            />
            {previewLabel}
          </button>
        ) : null}
        {onDownload ? (
          <button
            className="inline-flex items-center gap-1 border-0 bg-transparent p-0 font-sans text-accent-blue text-xs"
            onClick={onDownload}
            type="button"
          >
            <HugeiconsIcon
              icon={Download04Icon}
              size={13}
            />
            {downloadLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}
