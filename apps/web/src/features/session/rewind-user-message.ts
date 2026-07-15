import type { MessageId, SessionId } from '@monad/protocol';

interface RewindUserMessageArgs {
  messageId: MessageId;
  restore: (request: { id: SessionId; toMessageId: MessageId }) => Promise<unknown>;
  sessionId: SessionId;
  text: string;
}

export async function rewindUserMessage({
  messageId,
  restore,
  sessionId,
  text
}: RewindUserMessageArgs): Promise<string | null> {
  try {
    await restore({ id: sessionId, toMessageId: messageId });
    return text;
  } catch {
    return null;
  }
}
