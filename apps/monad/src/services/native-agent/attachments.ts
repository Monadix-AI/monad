import type {
  FilePreviewReadResponse,
  FilePreviewResource,
  FilePreviewTarget,
  MessageAttachmentRef,
  NativeAgentAttachmentInput,
  SessionId
} from '@monad/protocol';
import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';

import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
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

  async function currentLocalPath(path: string, roots: readonly string[]): Promise<string> {
    if (roots.length === 0) {
      throw new HandlerError('forbidden', 'local file preview has no accessible roots', 'ATTACHMENT_WORKSPACE_MISSING');
    }
    const resolvedRoots = (
      await Promise.all(
        roots.map(async (root) => {
          try {
            return await realpath(root);
          } catch {
            return null;
          }
        })
      )
    ).filter((root): root is string => root !== null);
    const candidates = isAbsolute(path) ? [path] : resolvedRoots.map((root) => resolve(root, path));
    for (const candidate of candidates) {
      try {
        const resolvedPath = await realpath(candidate);
        const stats = await stat(resolvedPath);
        if (!stats.isFile()) continue;
        for (const resolvedRoot of resolvedRoots) {
          const rel = relative(resolvedRoot, resolvedPath);
          if (!rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return resolvedPath;
        }
      } catch {}
    }
    throw new HandlerError('forbidden', `local file is outside accessible roots: ${path}`, 'ATTACHMENT_PATH_FORBIDDEN');
  }

  async function readResource(
    resource: FilePreviewResource,
    options: { download: boolean; inline: boolean }
  ): Promise<Response | FilePreviewReadResponse> {
    const file = Bun.file(resource.path);
    if (options.inline) {
      if (!isPdfAttachmentMime(resource.mime)) {
        throw new HandlerError('invalid', `inline preview is not supported for file: ${resource.path}`);
      }
      return new Response(file, {
        headers: {
          'cache-control': 'private, no-store',
          'content-disposition': attachmentContentDisposition(resource.name, 'inline'),
          'content-type': 'application/pdf',
          'x-content-type-options': 'nosniff'
        }
      });
    }
    if (options.download) {
      return new Response(file, {
        headers: {
          'content-type': resource.mime,
          'content-disposition': attachmentContentDisposition(resource.name)
        }
      });
    }
    const previewable = isPreviewableAttachmentMime(resource.mime);
    const currentBytes = file.size;
    const text = previewable ? await file.slice(0, Math.min(currentBytes, ATTACHMENT_INLINE_READ_MAX)).text() : '';
    return {
      resource,
      text,
      truncated: previewable && currentBytes > ATTACHMENT_INLINE_READ_MAX
    };
  }

  async function registeredResource(id: string) {
    const attachment = store.getMessageAttachment(id);
    if (!attachment) throw new HandlerError('not_found', `attachment not found: ${id}`);
    const path = await currentAttachmentPath(attachment);
    return {
      path,
      name: attachment.name,
      mime: attachment.mime,
      bytes: attachment.bytes
    } satisfies FilePreviewResource;
  }

  return {
    async preview(
      target: FilePreviewTarget,
      options: { download: boolean; inline: boolean },
      roots: readonly string[] = []
    ): Promise<Response | FilePreviewReadResponse> {
      if ('attachmentId' in target) {
        return readResource(await registeredResource(target.attachmentId), options);
      }
      const path = await currentLocalPath(target.path, roots);
      const file = Bun.file(path);
      const mime = file.type.split(';')[0]?.trim() || 'application/octet-stream';
      return readResource({ path, name: basename(path), mime, bytes: file.size }, options);
    }
  };
}
