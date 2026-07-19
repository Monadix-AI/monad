import type { MessageAttachment, SendMessageAttachment } from '@monad/protocol';
import type { ImageAttachment } from '#/agent/index.ts';

import { newId } from '@monad/protocol';

export function imageAttachments(attachments: SendMessageAttachment[] | undefined): ImageAttachment[] | undefined {
  const images = (attachments ?? [])
    .filter(
      (attachment): attachment is Extract<SendMessageAttachment, { kind: 'image' }> => attachment.kind === 'image'
    )
    .map((attachment) => ({
      image: new Uint8Array(Buffer.from(attachment.dataBase64, 'base64')),
      mediaType: attachment.mediaType
    }));
  return images.length ? images : undefined;
}

export function messageAttachmentPresentations(
  attachments: SendMessageAttachment[] | undefined,
  deps: {
    createdAt?: string;
    newAttachmentId?: (index: number) => MessageAttachment['id'];
  } = {}
): MessageAttachment[] {
  if (!attachments?.length) return [];
  const createdAt = deps.createdAt ?? new Date().toISOString();
  return attachments.map((attachment, index) => ({
    id: deps.newAttachmentId?.(index) ?? newId('att'),
    name: attachment.name,
    mime: attachment.mediaType || 'application/octet-stream',
    bytes: attachment.size,
    createdAt
  }));
}

function attachmentTextContext(attachments: SendMessageAttachment[] | undefined): string {
  if (!attachments?.length) return '';
  const lines = attachments.map((attachment, index) => {
    const heading = `Attachment ${index + 1}: ${attachment.name} (${attachment.mediaType || 'unknown'}, ${attachment.size} bytes)`;
    if (attachment.kind === 'text') return `${heading}\n${attachment.text}`;
    if (attachment.kind === 'image') return `${heading}\n[image attached to this turn]`;
    return `${heading}\n[file metadata only; binary content was not included]`;
  });
  return `\n\n<attachments>\n${lines.join('\n\n')}\n</attachments>`;
}

export function messageTextWithAttachments(text: string, attachments: SendMessageAttachment[] | undefined): string {
  const base = text.trim() || (attachments?.length ? 'Shared attachments.' : '');
  return `${base}${attachmentTextContext(attachments)}`;
}
