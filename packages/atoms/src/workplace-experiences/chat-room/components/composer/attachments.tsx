import type { DraftMessageAttachment } from '@monad/sdk-experience/react';
import type { ReactElement } from 'react';

import { type ComposerAttachmentItem, ComposerAttachmentStrip } from '@monad/ui';

export type DraftAttachment = DraftMessageAttachment;
export type ComposerDroppedFiles = { files: File[]; nonce: number };

export function attachmentMediaType(attachment: DraftAttachment): string {
  return attachment.kind === 'file-meta' ? (attachment.mediaType ?? '') : attachment.mediaType;
}

function attachmentItem(attachment: DraftAttachment): ComposerAttachmentItem {
  return {
    contentType: attachmentMediaType(attachment) || undefined,
    id: attachment.localId,
    imageSrc: attachment.kind === 'image' ? `data:${attachment.mediaType};base64,${attachment.dataBase64}` : undefined,
    name: attachment.virtualKind === 'pasted-text' ? 'Pasted' : attachment.name,
    openable: Boolean(attachment.localFile || attachment.kind === 'image' || attachment.kind === 'text'),
    size: attachment.size
  };
}

export function AttachmentPreviewStrip({
  attachments,
  onOpen,
  onRemove
}: {
  attachments: DraftAttachment[];
  onOpen: (attachment: DraftAttachment) => void;
  onRemove: (index: number) => void;
}): ReactElement {
  return (
    <ComposerAttachmentStrip
      attachments={attachments.map(attachmentItem)}
      labels={{
        attachments: 'Attachments',
        open: (name) => `Open ${name}`,
        remove: (name) => `Remove ${name}`
      }}
      onOpen={(localId) => {
        const attachment = attachments.find((item) => item.localId === localId);
        if (attachment) onOpen(attachment);
      }}
      onRemove={(localId) => {
        const index = attachments.findIndex((item) => item.localId === localId);
        if (index >= 0) onRemove(index);
      }}
    />
  );
}
