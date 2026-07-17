import type { ReactNode } from 'react';

import { Attachment01Icon, Download04Icon, EyeIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';

export interface AttachmentCardProps {
  downloadLabel: string;
  error: boolean;
  errorContent?: ReactNode;
  expanded: boolean;
  loading: boolean;
  loadingContent?: ReactNode;
  name: string;
  onDownload: () => void;
  onPreviewChange: (expanded: boolean) => void;
  path?: string;
  previewCollapseLabel: string;
  previewContent?: ReactNode;
  previewExpandLabel: string;
  previewable: boolean;
  sizeLabel: string;
}

export function AttachmentCard({
  downloadLabel,
  error,
  errorContent,
  expanded,
  loading,
  loadingContent,
  name,
  onDownload,
  onPreviewChange,
  path,
  previewCollapseLabel,
  previewContent,
  previewExpandLabel,
  previewable,
  sizeLabel
}: AttachmentCardProps) {
  return (
    <div className="mt-2 rounded-lg border border-border bg-card px-2.5 py-2 font-sans text-[13px] text-foreground">
      <div className="flex min-w-0 flex-wrap items-center gap-2.5">
        <HugeiconsIcon
          className="shrink-0 text-muted-foreground"
          icon={Attachment01Icon}
          size={14}
        />
        <span
          className="overflow-wrap-anywhere font-semibold"
          title={path}
        >
          {name}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">{sizeLabel}</span>
        {previewable ? (
          <button
            className="inline-flex items-center gap-1 border-0 bg-transparent p-0 font-sans text-accent-blue text-xs"
            onClick={() => onPreviewChange(!expanded)}
            type="button"
          >
            <HugeiconsIcon
              icon={EyeIcon}
              size={13}
            />
            {expanded ? previewCollapseLabel : previewExpandLabel}
          </button>
        ) : null}
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
      </div>
      {expanded ? (
        <pre className="mt-2 max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-secondary px-2.5 py-2 font-mono text-xs leading-6">
          {error ? errorContent : loading ? loadingContent : previewContent}
        </pre>
      ) : null}
    </div>
  );
}
