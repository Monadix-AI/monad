import type { BranchSessionResponse, MessageId, SessionId } from '@monad/protocol';

interface BranchFromMessageArgs {
  branch: (messageId: MessageId) => Promise<BranchSessionResponse>;
  continueFromHistory: (sessionId: SessionId) => Promise<unknown>;
  messageId: MessageId;
  onBranched: (sessionId: SessionId) => void;
  role: 'user' | 'assistant';
}

export async function branchFromMessage({
  branch,
  continueFromHistory,
  messageId,
  onBranched,
  role
}: BranchFromMessageArgs): Promise<SessionId> {
  const { sessionId } = await branch(messageId);
  onBranched(sessionId);
  if (role === 'user') await continueFromHistory(sessionId);
  return sessionId;
}
