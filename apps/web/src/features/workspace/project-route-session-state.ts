import type { SessionId } from '@monad/protocol';

type ProjectRouteSession = {
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
  if (!routedSessionId) return { activeSessionId: null, activeSessionTitle: null };
  const routedSession = project.projectSessions.find((session) => session.id === routedSessionId);
  if (!routedSession) return { activeSessionId: null, activeSessionTitle: null };
  return {
    activeSessionId: routedSessionId,
    activeSessionTitle: routedSession.title
  };
}
