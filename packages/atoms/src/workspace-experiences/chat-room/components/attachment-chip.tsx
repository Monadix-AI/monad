import type { MessageAttachment } from '../../experience/types.ts';

import { isPreviewableAttachmentMime } from '@monad/protocol';
import { useDownloadAttachmentMutation, useLazyGetAttachmentQuery } from '@monad/sdk-experience/react';
import { AttachmentCard } from '@monad/ui';
import { useState } from 'react';

import { workspaceExperienceT } from '../../i18n.ts';

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

export function AttachmentChip({ attachment }: { attachment: MessageAttachment }): React.ReactElement {
  const t = workspaceExperienceT();
  const [expanded, setExpanded] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const previewable = isPreviewableAttachmentMime(attachment.mime);
  const [triggerGetAttachment] = useLazyGetAttachmentQuery();
  const [downloadAttachment] = useDownloadAttachmentMutation();
  const togglePreview = async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (content !== null || loading) return;
    setLoading(true);
    setError(false);
    try {
      const body = await triggerGetAttachment({ id: attachment.id }).unwrap();
      const text = typeof body.text === 'string' ? body.text : '';
      setContent(body.truncated ? `${text}...` : text);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };
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
      setError(true);
      setExpanded(true);
    }
  };
  return (
    <AttachmentCard
      downloadLabel={t('web.workplace.attachmentDownload')}
      error={error}
      errorContent={t('web.workplace.attachmentLoadError')}
      expanded={expanded}
      loading={loading || content === null}
      loadingContent="..."
      name={attachment.name}
      onDownload={() => void download()}
      onPreviewChange={() => void togglePreview()}
      path={attachment.path}
      previewable={previewable}
      previewCollapseLabel={t('web.workplace.attachmentCollapse')}
      previewContent={content}
      previewExpandLabel={t('web.workplace.attachmentPreview')}
      sizeLabel={formatAttachmentSize(attachment.bytes)}
    />
  );
}
