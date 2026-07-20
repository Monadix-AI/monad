import type { SessionId } from '@monad/protocol';

type ProjectRouteSession = {
  archived?: boolean;
  id: SessionId | string;
  title: string;
};

type ProjectRouteSessionSource = {
  activeSessionId: SessionId | string | null;
  projectSessions: readonly ProjectRouteSession[];
};

export type ProjectRouteSessionState = {
  activeSessionId: SessionId | null;
  activeSessionTitle: string | null;
};

export function deriveProjectRouteSessionState(
  project: ProjectRouteSessionSource,
  routedSessionId: SessionId | null
): ProjectRouteSessionState {
  const selectedSessionId = routedSessionId ?? project.activeSessionId;
  if (!selectedSessionId) return { activeSessionId: null, activeSessionTitle: null };
  const selectedSession = project.projectSessions.find((session) => session.id === selectedSessionId);
  if (!selectedSession || (!routedSessionId && selectedSession.archived)) {
    return { activeSessionId: null, activeSessionTitle: null };
  }
  return {
    activeSessionId: selectedSessionId as SessionId,
    activeSessionTitle: selectedSession.title
  };
}
