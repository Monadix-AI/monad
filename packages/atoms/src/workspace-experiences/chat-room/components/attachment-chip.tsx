import type { MessageAttachment } from '../../experience/types.ts';

import { isPreviewableAttachmentMime } from '@monad/protocol';
import { useDownloadAttachmentMutation } from '@monad/sdk-experience/react';
import { AttachmentCard } from '@monad/ui';

import { workspaceExperienceT } from '../../i18n.ts';

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

export function AttachmentChip({
  attachment,
  onPreview
}: {
  attachment: MessageAttachment;
  onPreview?: (attachment: MessageAttachment, line?: number) => void;
}): React.ReactElement {
  const t = workspaceExperienceT();
  const previewable = isPreviewableAttachmentMime(attachment.mime);
  const [downloadAttachment] = useDownloadAttachmentMutation();
  const download = async () => {
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
      onDownload={() => void download()}
      onPreview={() => onPreview?.(attachment)}
      path={attachment.path}
      previewable={previewable}
      previewLabel={t('web.workplace.attachmentPreview')}
      sizeLabel={formatAttachmentSize(attachment.bytes)}
    />
  );
}
