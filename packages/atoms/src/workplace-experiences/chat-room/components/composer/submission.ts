import type { SendMessageAttachment } from '@monad/protocol';

export type ProjectComposerSubmission = {
  attachments: SendMessageAttachment[];
  replyGeneration?: number;
  replyToMessageId?: string;
  text: string;
};

export function projectComposerSubmission({
  attachments,
  replyGeneration,
  replyToMessageId,
  text
}: ProjectComposerSubmission): ProjectComposerSubmission | null {
  const submission = {
    attachments,
    ...(replyGeneration === undefined ? {} : { replyGeneration }),
    ...(replyToMessageId ? { replyToMessageId } : {}),
    text: text.trim()
  };
  if (!submission.text && submission.attachments.length === 0) return null;
  return submission;
}
