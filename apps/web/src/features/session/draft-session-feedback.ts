import type { DraftChatSession } from '#/lib/workspace-shell-store';
import type { Msg } from './ChatMessage';
import type { ViewItem } from './chat-view-items';
import type { MessageAttachmentView } from './message-attachment-view';

import { messageAttachmentsFromSend } from './use-composer-attachments';

export function resolveDraftAgentLabel({
  agentId,
  agents,
  defaultLabel
}: {
  agentId: string | undefined;
  agents: Array<{ id: string; name: string }>;
  defaultLabel: string;
}): string {
  return (agentId ? agents.find((agent) => agent.id === agentId)?.name : undefined) ?? defaultLabel;
}

export function buildDraftSessionFeedback({
  agentLabel,
  draft
}: {
  agentLabel: string;
  draft: DraftChatSession;
}): ViewItem[] {
  const userMessage = {
    ...(draft.attachments.length
      ? {
          attachments: messageAttachmentsFromSend(draft.attachments, {
            createdAt: draft.createdAt,
            newAttachmentId: (index) => `att_${String(index).padStart(12, '0')}`
          })
        }
      : {}),
    id: `draft:${draft.id}`,
    role: 'user',
    text: draft.text,
    ...(draft.status === 'failed' ? { error: true } : {})
  } satisfies Msg;

  if (draft.status === 'failed') return [userMessage];

  return buildPendingTurnFeedback({
    agentLabel,
    id: userMessage.id,
    message: {
      attachments: userMessage.attachments,
      text: userMessage.text
    }
  });
}

export function buildPendingTurnFeedback({
  agentLabel,
  id,
  message
}: {
  agentLabel: string;
  id: string;
  message: { attachments?: MessageAttachmentView[]; text: string };
}): Msg[] {
  return [
    {
      ...(message.attachments?.length ? { attachments: message.attachments } : {}),
      id,
      role: 'user',
      text: message.text
    },
    {
      id: `${id}:assistant`,
      label: agentLabel,
      pending: true,
      role: 'assistant',
      text: ''
    }
  ];
}
