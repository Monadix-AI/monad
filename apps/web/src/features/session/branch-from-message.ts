import type { BranchSessionResponse, MessageId, SessionId } from '@monad/protocol';

interface BranchFromMessageArgs {
  branch: (messageId: MessageId) => Promise<BranchSessionResponse>;
  continueFromHistory: (sessionId: SessionId) => Promise<unknown>;
  messageId: MessageId;
  onBranched: (sessionId: SessionId) => void;
}

export async function branchFromMessage({
  branch,
  continueFromHistory,
  messageId,
  onBranched
}: BranchFromMessageArgs): Promise<SessionId> {
  const { sessionId } = await branch(messageId);
  onBranched(sessionId);
  await continueFromHistory(sessionId);
  return sessionId;
}
