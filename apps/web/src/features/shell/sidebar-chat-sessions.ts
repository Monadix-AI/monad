import type { Session } from '@monad/protocol';

const MESH_SESSION_CLIENT = 'monad-app-server';

export function visibleSidebarSessions<T extends Pick<Session, 'origin' | 'projectId'>>(sessions: readonly T[]): T[] {
  return sessions.filter((session) => session.projectId || session.origin?.client !== MESH_SESSION_CLIENT);
}
