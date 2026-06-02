import type { NativeAgentDirectMessage, SessionId } from '@monad/protocol';
import type { MessageIngress } from '#/services/messages/types.ts';
import type { Store } from '#/store/db/index.ts';

import { messageIdempotencyKey } from '#/services/messages/ingress.ts';

// Membership is the canonical graph ONLY: a non-left SessionBinding + its ProjectMember (mesh-agent). A
// legacy session_members row is never proof of existence — after the Track B cutover a legacy-only member
// with no binding is graph corruption, not a receipt-worthy recipient.
function isDirectMessageMember(
  store: Store,
  sessionId: SessionId,
  projectId: string | null,
  memberId: string
): boolean {
  if (!projectId) return false;
  const binding = store.getSessionBinding(sessionId, memberId);
  if (!binding || binding.lifecycle === 'left') return false;
  return store.getProjectMember(projectId, memberId)?.type === 'mesh-agent';
}

// Display name for a canonical member id: the ProjectMember's displayName, falling back to the raw id.
function directMemberDisplayName(store: Store, projectId: string | null, memberId: string): string {
  if (projectId) {
    const member = store.getProjectMember(projectId, memberId);
    if (member) return member.displayName;
  }
  return memberId;
}

export async function writeNativeAgentDirectMessageReceipt(args: {
  message: NativeAgentDirectMessage;
  store: Store;
  messageIngress: Pick<MessageIngress, 'deliver'>;
}): Promise<void> {
  const fromAgentName = args.message.fromAgent;
  if (!fromAgentName) return;
  const peer = args.message.peer;
  if (peer === fromAgentName) return;
  const projectId = args.store.getSession(args.message.sessionId)?.projectId ?? null;
  // A receipt is only written when the peer is a real member of the session — a private-label peer never
  // reaches here (send skips delivery/receipt for it), but guard anyway so a stray label writes nothing.
  if (!isDirectMessageMember(args.store, args.message.sessionId, projectId, peer)) return;
  const fromDisplayName = directMemberDisplayName(args.store, projectId, fromAgentName);
  const toDisplayName = directMemberDisplayName(args.store, projectId, peer);
  await args.messageIngress.deliver({
    transcriptTargetId: args.message.sessionId,
    idempotencyKey: messageIdempotencyKey('native-agent-direct-message', args.message.id),
    producer: { kind: 'system', subsystem: 'managed-mesh-agent' },
    role: 'assistant',
    type: 'mesh_agent_direct_message',
    text: `${fromDisplayName} sent ${toDisplayName} a DM.`,
    data: { message: args.message }
  });
}
