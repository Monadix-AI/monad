type ReplyMessage = {
  replyToMessageId?: string;
  role: 'assistant' | 'user';
};

export function sessionReplyPreviewTargetId({
  isProjectSession,
  message,
  previousVisibleItemId
}: {
  isProjectSession: boolean;
  message: ReplyMessage;
  previousVisibleItemId?: string;
}): string | undefined {
  const targetId = message.replyToMessageId;
  if (!targetId || previousVisibleItemId === targetId) return undefined;
  if (message.role === 'assistant' && !isProjectSession) return undefined;
  return targetId;
}
