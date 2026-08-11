import type {
  AttachmentReadResponse,
  MessageAttachmentRef,
  NativeAgentAttachmentInput,
  SessionId
} from '@monad/protocol';
import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';

import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import {
  attachmentPreviewText,
  isPdfAttachmentMime,
  isPreviewableAttachmentMime,
  NATIVE_AGENT_ATTACHMENT_PREVIEW_MAX,
  NATIVE_AGENT_ATTACHMENTS_MAX,
  newId
} from '@monad/protocol';

import { HandlerError } from '#/handlers/handler-error.ts';
import { parseNativeAgentFileReferences } from './file-refs.ts';

const ATTACHMENT_PREVIEW_READ_BYTES = NATIVE_AGENT_ATTACHMENT_PREVIEW_MAX * 4;
const ATTACHMENT_INLINE_READ_MAX = 1_000_000;

export type NativeAgentAttachmentResolver = (
  body: { text?: string; attachments?: NativeAgentAttachmentInput[] },
  binding: { sessionId: SessionId; createdBy: string },
  attachmentRoots: readonly string[]
) => Promise<{ text: string; noticeText: string; attachments: MessageAttachmentRef[] }>;

function attachmentNoticeText(text: string, refs: readonly MessageAttachmentRef[]): string {
  const markers = refs.map((ref) => `[Attachment ${ref.id}: ${ref.name} (${ref.bytes} bytes) — file at ${ref.path}]`);
  return [text, markers.join('\n')].filter(Boolean).join('\n\n');
}

function attachmentContentDisposition(name: string, disposition: 'attachment' | 'inline' = 'attachment'): string {
  const asciiFallback = name.replace(/[^\x20-\x7e]+/g, '_').replace(/["\\]/g, '_');
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function snapshotAttachmentInput(
  input: NativeAgentAttachmentInput
): Promise<{ ref: Omit<MessageAttachmentRef, 'id' | 'createdAt'>; preview: string }> {
  let resolved: string;
  let size: number;
  try {
    resolved = await realpath(input.path);
    const stats = await stat(resolved);
    if (!stats.isFile()) throw new Error('not a regular file');
    size = stats.size;
  } catch {
    throw new HandlerError(
      'invalid',
      `attachment file not found or unreadable: ${input.path}`,
      'ATTACHMENT_FILE_MISSING'
    );
  }
  const sniffed = Bun.file(resolved).type.split(';')[0]?.trim();
  const mime = input.mime ?? (sniffed || 'application/octet-stream');
  let preview = '';
  if (isPreviewableAttachmentMime(mime) && size > 0) {
    const truncated = size > ATTACHMENT_PREVIEW_READ_BYTES;
    const head = await Bun.file(resolved).slice(0, Math.min(size, ATTACHMENT_PREVIEW_READ_BYTES)).text();
    preview = attachmentPreviewText(truncated ? head.replace(/�+$/, '') : head);
  }
  return {
    ref: { path: resolved, name: input.name ?? basename(resolved), mime, bytes: size },
    preview
  };
}

export function createNativeAgentAttachmentResolver(
  store: ReturnType<typeof createDaemonHandlers>['_nativeAgentStore']
): NativeAgentAttachmentResolver {
  return async function resolveAttachmentPayload(
    body: { text?: string; attachments?: NativeAgentAttachmentInput[] },
    binding: { sessionId: SessionId; createdBy: string },
    attachmentRoots: readonly string[]
  ): Promise<{ text: string; noticeText: string; attachments: MessageAttachmentRef[] }> {
    const parsed = body.text ? parseNativeAgentFileReferences(body.text) : { text: body.text ?? '', paths: [] };
    const baseAttachmentRoot = attachmentRoots[0];
    const markerAttachments = parsed.paths.map((path) => {
      if (isAbsolute(path)) return { path };
      if (!baseAttachmentRoot) {
        throw new HandlerError(
          'invalid',
          'native agent attachment roots are not accessible',
          'ATTACHMENT_WORKSPACE_MISSING'
        );
      }
      return { path: resolve(baseAttachmentRoot, path) };
    });
    const attachmentInputs = [...markerAttachments, ...(body.attachments ?? [])];
    if (attachmentInputs.length > NATIVE_AGENT_ATTACHMENTS_MAX) {
      throw new HandlerError(
        'invalid',
        `at most ${NATIVE_AGENT_ATTACHMENTS_MAX} file attachments per message`,
        'ATTACHMENT_LIMIT_EXCEEDED'
      );
    }
    if (!attachmentInputs.length) {
      const text = parsed.text;
      return { text, noticeText: text, attachments: [] };
    }
    const snapshots = await Promise.all(attachmentInputs.map(snapshotAttachmentInput));
    const createdAt = new Date().toISOString();
    const attachments = store.registerMessageAttachments(
      snapshots.map(({ ref, preview }) => ({
        id: newId('att'),
        sessionId: binding.sessionId,
        ...ref,
        preview,
        createdBy: binding.createdBy,
        createdAt
      }))
    );
    const text = parsed.text || snapshots.find((snapshot) => snapshot.preview)?.preview || '';
    return { text, noticeText: attachmentNoticeText(text, attachments), attachments };
  };
}

export function createNativeAgentAttachmentReader(store: ReturnType<typeof createDaemonHandlers>['_nativeAgentStore']) {
  async function currentAttachmentPath(
    attachment: MessageAttachmentRef & { sessionId: string; createdBy: string | null }
  ): Promise<string> {
    let resolved: string;
    try {
      resolved = await realpath(attachment.path);
      const stats = await stat(resolved);
      if (!stats.isFile()) throw new Error('not a regular file');
    } catch {
      throw new HandlerError('gone', `attachment file no longer exists: ${attachment.path}`, 'ATTACHMENT_FILE_MISSING');
    }
    if (resolved !== attachment.path) {
      throw new HandlerError(
        'forbidden',
        `attachment path changed after registration: ${attachment.path}`,
        'ATTACHMENT_PATH_CHANGED'
      );
    }
    return resolved;
  }

  return {
    async read(
      id: string,
      options: { download: boolean; inline: boolean }
    ): Promise<Response | AttachmentReadResponse> {
      const attachment = store.getMessageAttachment(id);
      if (!attachment) throw new HandlerError('not_found', `attachment not found: ${id}`);
      const { sessionId: _sessionId, preview: _preview, createdBy: _createdBy, ...ref } = attachment;
      const path = await currentAttachmentPath(attachment);
      const file = Bun.file(path);
      if (options.inline) {
        if (!isPdfAttachmentMime(attachment.mime)) {
          throw new HandlerError('invalid', `inline preview is not supported for attachment: ${id}`);
        }
        return new Response(file, {
          headers: {
            'cache-control': 'private, no-store',
            'content-disposition': attachmentContentDisposition(attachment.name, 'inline'),
            'content-type': 'application/pdf',
            'x-content-type-options': 'nosniff'
          }
        });
      }
      if (options.download) {
        return new Response(file, {
          headers: {
            'content-type': attachment.mime,
            'content-disposition': attachmentContentDisposition(attachment.name)
          }
        });
      }
      const previewable = isPreviewableAttachmentMime(attachment.mime);
      const size = file.size;
      const text = previewable ? await file.slice(0, Math.min(size, ATTACHMENT_INLINE_READ_MAX)).text() : '';
      return {
        attachment: ref,
        text,
        truncated: previewable && size > ATTACHMENT_INLINE_READ_MAX
      };
    }
  };
}
