import type { MonadMcpAttachment } from './monad-mcp-projection.ts';

import { ArrowDown01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { CompactFilePath, FileIcon } from '@monad/ui';
import { fileBaseName } from '@monad/ui/components/FileIcon';
import { requestVirtualListRowMeasurement } from '@monad/ui/components/VirtualList';

import { workplaceExperienceT } from '../../../i18n.ts';
import { useObservationDisclosure } from './disclosure.tsx';

export function MonadMcpAttachmentList({
  attachments,
  locale
}: {
  attachments: readonly MonadMcpAttachment[];
  locale: string;
}) {
  if (attachments.length === 0) return null;
  return (
    <div
      className="mt-2 grid gap-1.5"
      data-slot="monad-mcp-attachments"
    >
      {attachments.map((attachment, index) => (
        <MonadMcpAttachmentCard
          attachment={attachment}
          disclosureKey={attachment.id ?? `${attachment.path}:${index}`}
          key={attachment.id ?? `${attachment.path}:${index}`}
          locale={locale}
        />
      ))}
    </div>
  );
}

function MonadMcpAttachmentCard({
  attachment,
  disclosureKey,
  locale
}: {
  attachment: MonadMcpAttachment;
  disclosureKey: string;
  locale: string;
}) {
  const t = workplaceExperienceT();
  const [open, setOpen] = useObservationDisclosure(`attachment/${disclosureKey}`);
  const name = attachment.name ?? fileBaseName(attachment.path);
  const size = formatAttachmentSize(attachment.bytes);
  const summaryMeta = [attachment.mime, size].filter(Boolean).join(' · ');
  const metadata = [
    {
      key: 'path',
      label: t('web.workplace.monadMcp.attachmentPath'),
      value: (
        <CompactFilePath
          className="font-ui text-foreground"
          path={attachment.path}
        />
      )
    },
    ...(attachment.mime
      ? [{ key: 'mime', label: t('web.workplace.monadMcp.attachmentMime'), value: attachment.mime }]
      : []),
    ...(attachment.bytes === undefined
      ? []
      : [
          {
            key: 'size',
            label: t('web.workplace.monadMcp.attachmentSize'),
            value: `${size} · ${new Intl.NumberFormat(locale).format(attachment.bytes)} B`
          }
        ]),
    ...(attachment.id ? [{ key: 'id', label: t('web.workplace.monadMcp.attachmentId'), value: attachment.id }] : []),
    ...(attachment.createdAt
      ? [
          {
            key: 'createdAt',
            label: t('web.workplace.monadMcp.attachmentCreatedAt'),
            value: formatAttachmentCreatedAt(attachment.createdAt, locale)
          }
        ]
      : [])
  ];
  return (
    <details
      className="group/attachment overflow-hidden rounded-lg border border-border/70 bg-card/45 open:bg-card/70"
      data-slot="monad-mcp-attachment-card"
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
        requestVirtualListRowMeasurement(event.currentTarget);
      }}
      open={open}
    >
      <summary className="flex min-h-9 min-w-0 cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/35 [&::-webkit-details-marker]:hidden">
        <FileIcon
          className="size-4 shrink-0 text-muted-foreground"
          contentType={attachment.mime}
          fileName={name}
        />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{name}</span>
        {summaryMeta ? (
          <span className="max-w-[45%] truncate font-ui text-[10px] text-muted-foreground">{summaryMeta}</span>
        ) : null}
        <HugeiconsIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 -rotate-90 text-muted-foreground transition-transform duration-150 group-open/attachment:rotate-0"
          icon={ArrowDown01Icon}
        />
      </summary>
      <dl
        className="grid grid-cols-[minmax(5.5rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-border/60 border-t px-2.5 py-2 text-xs"
        data-slot="monad-mcp-attachment-meta"
      >
        {metadata.map((entry) => (
          <div
            className="contents"
            data-attachment-meta-field={entry.key}
            key={entry.key}
          >
            <dt className="text-muted-foreground">{entry.label}</dt>
            <dd className="wrap-anywhere min-w-0 font-ui text-foreground">{entry.value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function formatAttachmentSize(bytes: number | undefined): string | undefined {
  if (bytes === undefined) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

function formatAttachmentCreatedAt(value: string, locale: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(timestamp));
}
