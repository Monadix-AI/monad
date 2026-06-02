import type { MessageAttachment, MessageAttachmentRef, SendMessageAttachment, SessionId } from '@monad/protocol';
import type { ImageAttachment } from '#/agent/index.ts';
import type { MessageAttachmentInsert } from '#/store/db/attachments.ts';

import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { attachmentPreviewText, newId } from '@monad/protocol';

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

export async function persistMessageAttachmentPresentations(
  attachments: SendMessageAttachment[] | undefined,
  deps: {
    workspaceDir: string;
    createdAt?: string;
    newAttachmentId?: (index: number) => MessageAttachment['id'];
    registerAttachments: (records: readonly MessageAttachmentInsert[]) => MessageAttachmentRef[];
    sessionId: SessionId;
  }
): Promise<MessageAttachment[]> {
  const presentations = messageAttachmentPresentations(attachments, deps);
  if (!attachments?.length) return presentations;
  const attachmentRoot = join(deps.workspaceDir, '.monad-attachments');
  const attachmentDir = join(attachmentRoot, deps.sessionId);
  const records: MessageAttachmentInsert[] = [];
  const writtenPaths: string[] = [];
  await mkdir(attachmentDir, { recursive: true, mode: 0o700 });
  await writeFile(join(attachmentRoot, '.gitignore'), '*\n', { flag: 'wx' }).catch(() => {});
  try {
    for (const [index, attachment] of attachments.entries()) {
      if (attachment.kind === 'file-meta') continue;
      const presentation = presentations[index];
      if (!presentation) continue;
      const data =
        attachment.kind === 'image' || attachment.kind === 'file'
          ? new Uint8Array(Buffer.from(attachment.dataBase64, 'base64'))
          : new TextEncoder().encode(attachment.text);
      const safeName = basename(presentation.name).replace(/[^\p{L}\p{N}._-]+/gu, '-') || 'file';
      const targetPath = join(attachmentDir, `${presentation.id}-${safeName}`);
      await writeFile(targetPath, data, { mode: 0o600 });
      const path = await realpath(targetPath);
      writtenPaths.push(path);
      records.push({
        id: presentation.id,
        sessionId: deps.sessionId,
        path,
        name: presentation.name,
        mime: presentation.mime,
        bytes: data.byteLength,
        preview: attachment.kind === 'text' ? attachmentPreviewText(attachment.text) : '',
        createdAt: presentation.createdAt
      });
    }
    const registered = new Map(deps.registerAttachments(records).map((attachment) => [attachment.id, attachment]));
    return presentations.map((presentation) => registered.get(presentation.id) ?? presentation);
  } catch (error) {
    await Promise.all(writtenPaths.map((path) => rm(path, { force: true })));
    throw error;
  }
}

function attachmentTextContext(
  attachments: SendMessageAttachment[] | undefined,
  presentations: MessageAttachment[] | undefined
): string {
  if (!attachments?.length) return '';
  const lines = attachments.map((attachment, index) => {
    const heading = `Attachment ${index + 1}: ${attachment.name} (${attachment.mediaType || 'unknown'}, ${attachment.size} bytes)`;
    if (attachment.kind === 'text') return `${heading}\n${attachment.text}`;
    if (attachment.kind === 'image') return `${heading}\n[image attached to this turn]`;
    const path = presentations?.[index]?.path;
    if (attachment.kind === 'file' && path) return `${heading}\n[uploaded file available at ${path}]`;
    return `${heading}\n[file metadata only; binary content was not included]`;
  });
  return `\n\n<attachments>\n${lines.join('\n\n')}\n</attachments>`;
}

export function messageTextWithAttachments(
  text: string,
  attachments: SendMessageAttachment[] | undefined,
  presentations?: MessageAttachment[]
): string {
  const base = text.trim() || (attachments?.length ? 'Shared attachments.' : '');
  return `${base}${attachmentTextContext(attachments, presentations)}`;
}
