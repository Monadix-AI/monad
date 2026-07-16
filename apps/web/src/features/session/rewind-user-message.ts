import type { MessageId, SessionId } from '@monad/protocol';

interface RewindUserMessageArgs {
  messageId: MessageId;
  restore: (request: { id: SessionId; toMessageId: MessageId }) => Promise<unknown>;
  send: (text: string) => Promise<unknown>;
  sessionId: SessionId;
  text: string;
}

export async function rewindUserMessage({
  messageId,
  restore,
  send,
  sessionId,
  text
}: RewindUserMessageArgs): Promise<boolean> {
  try {
    await restore({ id: sessionId, toMessageId: messageId });
    await send(text);
    return true;
  } catch {
    return false;
  }
}
