import type { SendMessageAttachment } from '@monad/protocol';

import { basename } from 'node:path';
import {
  MESSAGE_ATTACHMENT_BINARY_MAX_BYTES,
  MESSAGE_ATTACHMENT_MAX,
  MESSAGE_ATTACHMENT_TEXT_MAX
} from '@monad/protocol';

import { usageError } from '../commands/types.ts';
import { t } from './i18n.ts';

const TEXT_TYPES = /^(text\/|application\/(json|xml|yaml|x-yaml|javascript|typescript)|.*\+(json|xml)$)/;

function flagPaths(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return value ? [String(value)] : [];
}

/** Classify by the media type Bun infers from the extension: images ride as `image`, anything that
 *  is textual is sent as `text` so the model reads it directly, everything else as base64 `file`. */
async function readOne(path: string): Promise<SendMessageAttachment> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw usageError(t('cli.attach.missing', { path }));
  const mediaType = file.type.split(';')[0] || 'application/octet-stream';
  const name = basename(path);
  const size = file.size;

  if (TEXT_TYPES.test(mediaType)) {
    if (size > MESSAGE_ATTACHMENT_TEXT_MAX) throw usageError(t('cli.attach.tooLargeText', { path }));
    return { kind: 'text', name, mediaType, size, text: await file.text() };
  }
  if (size > MESSAGE_ATTACHMENT_BINARY_MAX_BYTES) throw usageError(t('cli.attach.tooLarge', { path }));
  const dataBase64 = Buffer.from(await file.arrayBuffer()).toString('base64');
  return mediaType.startsWith('image/')
    ? { kind: 'image', name, mediaType, size, dataBase64 }
    : { kind: 'file', name, mediaType, size, dataBase64 };
}

/** Resolve repeated `--file <path>` flags into wire attachments. Returns undefined when none were
 *  given so the request body stays minimal. */
export async function resolveAttachments(value: unknown): Promise<SendMessageAttachment[] | undefined> {
  const paths = flagPaths(value);
  if (paths.length === 0) return undefined;
  if (paths.length > MESSAGE_ATTACHMENT_MAX)
    throw usageError(t('cli.attach.tooMany', { count: MESSAGE_ATTACHMENT_MAX }));
  return Promise.all(paths.map(readOne));
}
