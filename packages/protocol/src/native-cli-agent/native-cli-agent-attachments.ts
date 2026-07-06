import { z } from 'zod';

import { attachmentIdSchema } from '../ids.ts';
import { absolutePath } from './native-cli-agent-paths.ts';

// Inline request-body cap (DoS guard). Longer content is spilled to a file and referenced as an
// attachment: the message/notice/inbox copies carry only a bounded preview + the file reference.
export const NATIVE_AGENT_INLINE_TEXT_MAX = 100_000;
// Preview snippet length embedded in wall messages and stdin fan-out notices.
export const NATIVE_AGENT_ATTACHMENT_PREVIEW_MAX = 2_000;

/** Bounded preview snippet for spilled content — what wall messages and fan-out notices embed.
 *  The cut point backs off one unit rather than splitting a surrogate pair (a split pair would
 *  render as � and re-encode as ill-formed UTF-8). */
export function attachmentPreviewText(text: string): string {
  if (text.length <= NATIVE_AGENT_ATTACHMENT_PREVIEW_MAX) return text;
  let end = NATIVE_AGENT_ATTACHMENT_PREVIEW_MAX;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** Mime families whose content is rendered as an inline text preview (daemon read + web button).
 *  Shared so the server's preview behavior and the client's Preview affordance never drift. */
const PREVIEWABLE_ATTACHMENT_MIME_RE = /^(text\/|application\/(json|x?ya?ml|xml|toml|javascript|typescript))/;
export function isPreviewableAttachmentMime(mime: string): boolean {
  return PREVIEWABLE_ATTACHMENT_MIME_RE.test(mime);
}

/** A message attachment is a STRUCTURED REFERENCE to a file on the daemon host — for humans to
 *  read (wall preview/download), never an execution input. The daemon registers the reference and
 *  snapshots metadata at post time; content stays in the file and is read on demand, so a later
 *  edit/delete of the file changes/breaks the preview (reference semantics, by design). */
export const messageAttachmentRefSchema = z.object({
  id: attachmentIdSchema,
  /** Absolute path on the daemon host (typically inside the posting agent's workspace). */
  path: z.string().min(1),
  name: z.string().min(1).max(200),
  mime: z.string().min(1).max(100),
  /** File size snapshot taken when the reference was registered. */
  bytes: z.number().int().nonnegative(),
  createdAt: z.string()
});
export type MessageAttachmentRef = z.infer<typeof messageAttachmentRefSchema>;

/** Caller-side attachment input: the local file to reference from the message. */
export const nativeAgentAttachmentInputSchema = z.object({
  path: absolutePath('attachment path must be absolute'),
  name: z.string().min(1).max(200).optional(),
  mime: z.string().min(1).max(100).optional()
});
export type NativeAgentAttachmentInput = z.infer<typeof nativeAgentAttachmentInputSchema>;

/** Client-facing read of a registered attachment (web wall preview). `text` is a bounded inline
 *  read of the referenced file; `truncated` marks a partial read of a larger file. */
export const attachmentReadResponseSchema = z.object({
  attachment: messageAttachmentRefSchema,
  text: z.string(),
  truncated: z.boolean().optional()
});
export type AttachmentReadResponse = z.infer<typeof attachmentReadResponseSchema>;

// Per-message attachment count cap.
export const NATIVE_AGENT_ATTACHMENTS_MAX = 10;

export const attachmentInputsSchema = z
  .array(nativeAgentAttachmentInputSchema)
  .min(1)
  .max(NATIVE_AGENT_ATTACHMENTS_MAX);
