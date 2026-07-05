import type {
  AttachmentReadResponse,
  MessageAttachmentRef,
  NativeAgentAttachmentInput,
  ProjectId
} from '@monad/protocol';
import type { createDaemonHandlers } from '@/handlers/handlers.ts';

import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve, sep } from 'node:path';
import {
  attachmentPreviewText,
  isPreviewableAttachmentMime,
  NATIVE_AGENT_ATTACHMENT_PREVIEW_MAX,
  NATIVE_AGENT_ATTACHMENTS_MAX,
  newId
} from '@monad/protocol';

import { HandlerError } from '@/handlers/handler-error.ts';
import { parseNativeAgentFileReferences } from './file-refs.ts';

const ATTACHMENT_PREVIEW_READ_BYTES = NATIVE_AGENT_ATTACHMENT_PREVIEW_MAX * 4;
const ATTACHMENT_INLINE_READ_MAX = 1_000_000;

export type NativeAgentAttachmentResolver = (
  body: { text?: string; attachments?: NativeAgentAttachmentInput[] },
  binding: { projectId: ProjectId; agentId: string },
  workingPath: string
) => Promise<{ text: string; noticeText: string; attachments: MessageAttachmentRef[] }>;

function attachmentNoticeText(text: string, refs: readonly MessageAttachmentRef[]): string {
  const markers = refs.map((ref) => `[Attachment ${ref.id}: ${ref.name} (${ref.bytes} bytes) — file at ${ref.path}]`);
  return [text, markers.join('\n')].filter(Boolean).join('\n\n');
}

function attachmentContentDisposition(name: string): string {
  const asciiFallback = name.replace(/[^\x20-\x7e]+/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function snapshotAttachmentInput(
  input: NativeAgentAttachmentInput,
  workspaceRealpath: string
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
  if (resolved !== workspaceRealpath && !resolved.startsWith(workspaceRealpath + sep)) {
    throw new HandlerError(
      'forbidden',
      `attachment path is outside the project working directory: ${input.path}`,
      'ATTACHMENT_PATH_OUTSIDE_WORKSPACE'
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
    binding: { projectId: ProjectId; agentId: string },
    workingPath: string
  ): Promise<{ text: string; noticeText: string; attachments: MessageAttachmentRef[] }> {
    const parsed = body.text ? parseNativeAgentFileReferences(body.text) : { text: body.text ?? '', paths: [] };
    const markerAttachments = parsed.paths.map((path) => ({
      path: isAbsolute(path) ? path : resolve(workingPath, path)
    }));
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
    const workspaceRealpath = await realpath(workingPath).catch(() => {
      throw new HandlerError(
        'invalid',
        `project working directory is not accessible: ${workingPath}`,
        'ATTACHMENT_WORKSPACE_MISSING'
      );
    });
    const snapshots = await Promise.all(
      attachmentInputs.map((input) => snapshotAttachmentInput(input, workspaceRealpath))
    );
    const createdAt = new Date().toISOString();
    const attachments = store.registerMessageAttachments(
      snapshots.map(({ ref, preview }) => ({
        id: newId('att'),
        projectId: binding.projectId,
        ...ref,
        preview,
        createdBy: binding.agentId,
        createdAt
      }))
    );
    const text = parsed.text || snapshots.find((snapshot) => snapshot.preview)?.preview || '';
    return { text, noticeText: attachmentNoticeText(text, attachments), attachments };
  };
}

export function createNativeAgentAttachmentReader(store: ReturnType<typeof createDaemonHandlers>['_nativeAgentStore']) {
  async function currentAttachmentPath(attachment: MessageAttachmentRef & { projectId: string }): Promise<string> {
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
    const project = store.getSession(attachment.projectId) ?? store.getWorkplaceProject(attachment.projectId);
    if (project?.cwd) {
      const workspaceRealpath = await realpath(project.cwd).catch(() => null);
      if (!workspaceRealpath || (resolved !== workspaceRealpath && !resolved.startsWith(workspaceRealpath + sep))) {
        throw new HandlerError(
          'forbidden',
          `attachment path is outside the project working directory: ${attachment.path}`,
          'ATTACHMENT_PATH_OUTSIDE_WORKSPACE'
        );
      }
    }
    return resolved;
  }

  return {
    async read(id: string, download: boolean): Promise<Response | AttachmentReadResponse> {
      const attachment = store.getMessageAttachment(id);
      if (!attachment) throw new HandlerError('not_found', `attachment not found: ${id}`);
      const { projectId: _projectId, preview: _preview, ...ref } = attachment;
      const path = await currentAttachmentPath(attachment);
      const file = Bun.file(path);
      if (download) {
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
