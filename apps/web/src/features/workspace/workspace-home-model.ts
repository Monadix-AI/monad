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

export function workspaceLaunchErrorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message) return error.message;
  if (!error || typeof error !== 'object') return null;

  const data = 'data' in error ? error.data : null;
  if (!data || typeof data !== 'object' || !('message' in data)) return null;
  return typeof data.message === 'string' && data.message.trim() ? data.message : null;
}
