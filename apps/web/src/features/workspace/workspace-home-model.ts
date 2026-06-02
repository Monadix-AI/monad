import type {
  AgentId,
  IdempotencyKey,
  SendMessageAttachment,
  SendMessageRequest,
  SendMessageResponse,
  SessionId
} from '@monad/protocol';
import type { DraftChatSession } from '#/lib/workspace-shell-store';

export type WorkspaceLaunchTarget =
  | { kind: 'new-agent' }
  | { kind: 'existing-agent'; sessionId: string }
  | { kind: 'project'; projectId: string };

export function resolveWorkspaceLaunchTarget(input: {
  mode: 'agent' | 'project';
  selectedAgentSessionId: string | null;
  selectedProjectId: string | null;
}): WorkspaceLaunchTarget | null {
  if (input.mode === 'project') {
    return input.selectedProjectId ? { kind: 'project', projectId: input.selectedProjectId } : null;
  }

  return input.selectedAgentSessionId
    ? { kind: 'existing-agent', sessionId: input.selectedAgentSessionId }
    : { kind: 'new-agent' };
}

export function workspaceSessionTitleFromDraft(draft: string, fallback = 'New chat'): string {
  const title = draft.trim().slice(0, 72);
  return title || fallback;
}

export function workspaceDraftCanLaunch(text: string, attachments: readonly SendMessageAttachment[]): boolean {
  return text.trim().length > 0 || attachments.length > 0;
}

export function workspaceInitialMessageRequest(draft: DraftChatSession, sessionId: SessionId) {
  return {
    attachments: draft.attachments,
    idempotencyKey: draft.sendIdempotencyKey,
    sessionId,
    text: draft.text
  };
}

type MutationResult<T> = { unwrap: () => Promise<T> };

export async function createAndSendWorkspaceDraft(
  draft: DraftChatSession,
  operations: {
    createSession: (request: {
      agentId?: AgentId;
      idempotencyKey: IdempotencyKey;
      title: string;
    }) => MutationResult<SessionId>;
    sendMessage: (
      request: { idempotencyKey: IdempotencyKey; sessionId: SessionId } & SendMessageRequest
    ) => MutationResult<SendMessageResponse>;
    onSessionCreated?: (sessionId: SessionId) => void;
  }
): Promise<SessionId> {
  const sessionId = await operations
    .createSession({
      title: draft.title,
      ...(draft.agentId ? { agentId: draft.agentId } : {}),
      idempotencyKey: draft.createIdempotencyKey
    })
    .unwrap();
  operations.onSessionCreated?.(sessionId);
  await operations.sendMessage(workspaceInitialMessageRequest(draft, sessionId)).unwrap();
  return sessionId;
}

export function workspaceLaunchErrorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message) return error.message;
  if (!error || typeof error !== 'object') return null;

  const data = 'data' in error ? error.data : null;
  if (!data || typeof data !== 'object' || !('message' in data)) return null;
  return typeof data.message === 'string' && data.message.trim() ? data.message : null;
}
