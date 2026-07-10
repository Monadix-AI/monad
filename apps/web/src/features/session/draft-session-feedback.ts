import type { DraftChatSession } from '#/lib/workspace-shell-store';
import type { ViewItem } from './chat-view-items';

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
  const userMessage: ViewItem = {
    id: `draft:${draft.id}`,
    role: 'user',
    text: draft.text,
    ...(draft.status === 'failed' ? { error: true } : {})
  };

  if (draft.status === 'failed') return [userMessage];

  return [
    userMessage,
    {
      id: `draft:${draft.id}:assistant`,
      label: agentLabel,
      pending: true,
      role: 'assistant',
      text: ''
    }
  ];
}
