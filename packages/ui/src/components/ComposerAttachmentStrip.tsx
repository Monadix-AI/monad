import { Cancel01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';

import { FileIcon } from './FileIcon.tsx';
import { ImageZoom } from './ImageZoom.tsx';

export interface ComposerAttachmentItem {
  contentType?: string;
  id: string;
  imageSrc?: string;
  name: string;
  openable?: boolean;
  size: number;
}

export interface ComposerAttachmentLabels {
  attachments: string;
  open: (name: string) => string;
  remove?: (name: string) => string;
}

export interface ComposerAttachmentRow extends Omit<ComposerAttachmentItem, 'size'> {
  sizeLabel: string;
}

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

export function composerAttachmentRows(attachments: readonly ComposerAttachmentItem[]): ComposerAttachmentRow[] {
  return attachments.map((attachment) => ({
    contentType: attachment.contentType,
    id: attachment.id,
    imageSrc: attachment.imageSrc,
    name: attachment.name,
    openable: attachment.openable ?? false,
    sizeLabel: formatAttachmentSize(attachment.size)
  }));
}

export function ComposerAttachmentStrip({
  attachments,
  labels,
  onOpen,
  onRemove
}: {
  attachments: readonly ComposerAttachmentItem[];
  labels: ComposerAttachmentLabels;
  onOpen?: (id: string) => void;
  onRemove?: (id: string) => void;
}) {
  return (
    <ul
      aria-label={labels.attachments}
      className="flex list-none gap-2 overflow-x-auto overscroll-x-contain p-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {composerAttachmentRows(attachments).map((attachment) => {
        const thumbnail = (
          <span className="flex size-[38px] shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-secondary">
            {attachment.imageSrc ? (
              <ImageZoom
                className="[&_[data-rmiz-content]]:h-full [&_[data-rmiz-content]]:w-full [&_[data-rmiz]]:h-full [&_[data-rmiz]]:w-full [&_img]:h-full [&_img]:w-full [&_img]:object-cover"
                zoomMargin={24}
              >
                {/* biome-ignore lint/performance/noImgElement: local data URLs cannot use an image optimizer. */}
                <img
                  alt=""
                  draggable={false}
                  src={attachment.imageSrc}
                />
              </ImageZoom>
            ) : (
              <FileIcon
                className="size-[18px] text-muted-foreground"
                contentType={attachment.contentType}
                fileName={attachment.name}
              />
            )}
          </span>
        );
        const details = (
          <span className="min-w-0">
            <span className="block truncate font-semibold text-xs">{attachment.name}</span>
            <span className="block font-mono text-[10px] text-muted-foreground">{attachment.sizeLabel}</span>
          </span>
        );
        const contentClassName = [
          'flex h-full min-w-0 items-center gap-2 border-0 bg-transparent py-[7px] pl-2 text-left text-foreground',
          onRemove ? 'pr-8' : 'pr-2'
        ].join(' ');

        return (
          <li
            className="relative h-14 w-[168px] shrink-0 overflow-hidden rounded-[10px] border bg-card"
            key={attachment.id}
          >
            {attachment.openable && onOpen && !attachment.imageSrc ? (
              <button
                aria-label={labels.open(attachment.name)}
                className={contentClassName}
                onClick={() => onOpen(attachment.id)}
                type="button"
              >
                {thumbnail}
                {details}
              </button>
            ) : (
              <span className={contentClassName}>
                {thumbnail}
                {details}
              </span>
            )}
            {onRemove && labels.remove ? (
              <button
                aria-label={labels.remove(attachment.name)}
                className="absolute top-1.5 right-1.5 inline-flex size-[22px] items-center justify-center rounded-full border-0 bg-transparent p-0 text-muted-foreground hover:bg-muted"
                onClick={() => onRemove(attachment.id)}
                type="button"
              >
                <HugeiconsIcon
                  aria-hidden
                  icon={Cancel01Icon}
                  size={14}
                />
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
