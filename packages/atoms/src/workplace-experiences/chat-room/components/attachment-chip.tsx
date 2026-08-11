import type { MessageAttachment } from '../../experience/types.ts';

import { useDownloadAttachmentMutation } from '@monad/sdk-experience/react';
import { AttachmentCard } from '@monad/ui';

import { workplaceExperienceT } from '../../i18n.ts';

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

export function isAttachmentPreviewable(attachment: MessageAttachment): boolean {
  return Boolean(attachment.path);
}

export function AttachmentChip({
  attachment,
  onPreview,
  tone
}: {
  attachment: MessageAttachment;
  onPreview?: (attachment: MessageAttachment, line?: number) => void;
  tone: 'agent' | 'human';
}): React.ReactElement {
  const t = workplaceExperienceT();
  const available = attachment.path !== undefined;
  const previewable = isAttachmentPreviewable(attachment);
  const [downloadAttachment] = useDownloadAttachmentMutation();
  const download = async () => {
    if (!available) return;
    try {
      const { blob } = await downloadAttachment({ id: attachment.id }).unwrap();
      const blobUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = blobUrl;
      anchor.download = attachment.name;
      anchor.click();
      URL.revokeObjectURL(blobUrl);
    } catch {
      return;
    }
  };
  return (
    <AttachmentCard
      downloadLabel={t('web.workplace.attachmentDownload')}
      mime={attachment.mime}
      name={attachment.name}
      onDownload={available ? () => void download() : undefined}
      onPreview={available && onPreview ? () => onPreview(attachment) : undefined}
      path={attachment.path}
      previewable={previewable}
      previewLabel={t('web.workplace.attachmentPreview')}
      sizeLabel={formatAttachmentSize(attachment.bytes)}
      tone={tone}
    />
  );
}
