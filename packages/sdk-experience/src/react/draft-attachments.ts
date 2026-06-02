import type { SendMessageAttachment } from '@monad/protocol';

import { MESSAGE_ATTACHMENT_BINARY_MAX_BYTES, MESSAGE_ATTACHMENT_TEXT_MAX } from '@monad/protocol';

export type DraftMessageAttachment = SendMessageAttachment & {
  localFile?: File;
  localId: string;
  virtualKind?: 'pasted-text';
};

function newDraftAttachmentId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `att:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function fileTextLike(file: File): boolean {
  return (
    file.type.startsWith('text/') ||
    ['application/json', 'application/xml', 'application/javascript', 'application/typescript'].includes(file.type) ||
    /\.(csv|json|log|md|txt|xml|yaml|yml)$/i.test(file.name)
  );
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export async function fileToDraftAttachment(file: File): Promise<DraftMessageAttachment> {
  if (file.size > MESSAGE_ATTACHMENT_BINARY_MAX_BYTES) {
    throw new Error(`attachment exceeds ${MESSAGE_ATTACHMENT_BINARY_MAX_BYTES} bytes`);
  }
  if (file.type.startsWith('image/')) {
    return {
      kind: 'image',
      localFile: file,
      localId: newDraftAttachmentId(),
      name: file.name || 'pasted-image',
      mediaType: file.type,
      size: file.size,
      dataBase64: await fileToBase64(file)
    };
  }
  if (fileTextLike(file) && file.size <= MESSAGE_ATTACHMENT_TEXT_MAX) {
    return {
      kind: 'text',
      localFile: file,
      localId: newDraftAttachmentId(),
      name: file.name || 'pasted-text.txt',
      mediaType: file.type || 'text/plain',
      size: file.size,
      text: await file.text()
    };
  }
  return {
    kind: 'file',
    localFile: file,
    localId: newDraftAttachmentId(),
    name: file.name || 'file',
    mediaType: file.type || 'application/octet-stream',
    size: file.size,
    dataBase64: await fileToBase64(file)
  };
}

export function pastedTextDraftAttachment(text: string): DraftMessageAttachment {
  const encoded = new TextEncoder().encode(text);
  const truncationNote = `\n\n[truncated: pasted text exceeded ${MESSAGE_ATTACHMENT_TEXT_MAX} bytes]`;
  let cappedText = text;
  if (encoded.byteLength > MESSAGE_ATTACHMENT_TEXT_MAX) {
    const budget = MESSAGE_ATTACHMENT_TEXT_MAX - new TextEncoder().encode(truncationNote).byteLength;
    cappedText = `${new TextDecoder().decode(encoded.slice(0, Math.max(0, budget)))}${truncationNote}`;
  }
  const file = new File([cappedText], 'pasted-text.txt', { type: 'text/plain' });
  return {
    kind: 'text',
    localFile: file,
    localId: newDraftAttachmentId(),
    name: 'Pasted',
    mediaType: 'text/plain',
    size: file.size,
    text: cappedText,
    virtualKind: 'pasted-text'
  };
}

export function sendableDraftAttachments(attachments: readonly DraftMessageAttachment[]): SendMessageAttachment[] {
  return attachments.map(
    ({ localFile: _localFile, localId: _localId, virtualKind: _virtualKind, ...attachment }) => attachment
  );
}

export async function draftAttachmentBase64(attachment: DraftMessageAttachment): Promise<string | null> {
  if (attachment.localFile) return fileToBase64(attachment.localFile);
  if (attachment.kind === 'image' || attachment.kind === 'file') return attachment.dataBase64;
  if (attachment.kind === 'text') {
    return fileToBase64(new File([attachment.text], attachment.name, { type: attachment.mediaType }));
  }
  return null;
}
