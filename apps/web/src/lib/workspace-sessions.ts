import type { MeshSessionView, Session, WorkplaceProject } from '@monad/protocol';

type WorkspaceProjectSessionListItem = { id: Session['id']; title: string };

export const safeDecode = (value: string): string => {
  let current = value;
  for (let i = 0; i < 3; i++) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      current = decoded;
    } catch {
      break;
    }
  }
  return current;
};

export const getWorkplaceProjectName = (session: Pick<WorkplaceProject, 'title'>): string =>
  formatProjectDisplayName(safeDecode(session.title));

export interface WorkspaceProjectListItem {
  id: string;
  name: string;
  cwd?: string;
  hasRunningAgent: boolean;
  sessions: (WorkspaceProjectSessionListItem & { pinned: boolean })[];
  unreadCount: number;
}

export interface BuildWorkspaceProjectsOptions {
  /** Every session (chat or project-bound) — used to resolve which project an mesh-agent
   *  session's sessionId belongs to, now that a project session's own id is distinct from its
   *  project's id (Track B). */
  sessions?: readonly Pick<Session, 'id' | 'projectId' | 'title' | 'updatedAt'>[];
  liveMeshSessions?: readonly MeshSessionView[];
  meshSessions?: readonly MeshSessionView[];
  pinnedSessionIds?: ReadonlySet<string>;
}

export const buildWorkspaceProjects = (
  projects: Pick<WorkplaceProject, 'id' | 'title' | 'cwd'>[] = [],
  options: BuildWorkspaceProjectsOptions = {}
): WorkspaceProjectListItem[] => {
  const sessionProjectId = new Map((options.sessions ?? []).map((s) => [s.id, s.projectId]));
  const sessionsByProjectId = new Map<string, (WorkspaceProjectSessionListItem & { updatedAt: string })[]>();
  for (const session of options.sessions ?? []) {
    if (!session.projectId) continue;
    const sessions = sessionsByProjectId.get(session.projectId) ?? [];
    sessions.push({ id: session.id, title: session.title, updatedAt: session.updatedAt });
    sessionsByProjectId.set(session.projectId, sessions);
  }
  const activityByProjectId = projectActivityById({
    sessionProjectId,
    liveMeshSessions: options.liveMeshSessions ?? [],
    meshSessions: options.meshSessions ?? options.liveMeshSessions ?? []
  });
  return projects
    .map((project, index) => {
      const activity = activityByProjectId.get(project.id);
      return {
        id: project.id,
        name: getWorkplaceProjectName(project),
        cwd: project.cwd,
        hasRunningAgent: activity?.hasRunningAgent ?? false,
        sessions: (sessionsByProjectId.get(project.id) ?? [])
          .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .map((session) => ({
            id: session.id,
            pinned: options.pinnedSessionIds?.has(session.id) ?? false,
            title: session.title
          })),
        unreadCount: activity?.unreadCount ?? 0,
        index
      };
    })
    .sort((a, b) => a.index - b.index)
    .map(({ index: _index, ...project }) => project);
};

function projectActivityById({
  sessionProjectId,
  liveMeshSessions,
  meshSessions
}: {
  sessionProjectId: ReadonlyMap<string, string | undefined>;
  liveMeshSessions: readonly MeshSessionView[];
  meshSessions: readonly MeshSessionView[];
}) {
  const activity = new Map<string, { hasRunningAgent: boolean; unreadCount: number }>();
  for (const session of meshSessions) {
    const projectId = sessionProjectId.get(session.sessionId);
    if (!projectId) continue;
    const current = activity.get(projectId) ?? { hasRunningAgent: false, unreadCount: 0 };
    current.unreadCount +=
      Math.max(0, session.lastDeliveredSeq - session.lastVisibleSeq) + session.pendingApprovalCount;
    activity.set(projectId, current);
  }
  for (const session of liveMeshSessions) {
    const projectId = sessionProjectId.get(session.sessionId);
    if (!projectId) continue;
    const current = activity.get(projectId) ?? { hasRunningAgent: false, unreadCount: 0 };
    current.hasRunningAgent ||= session.lifecycle.state !== 'terminal';
    activity.set(projectId, current);
  }
  return activity;
}

const createChannelName = (date = new Date()): string => {
  const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}-${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}${String(date.getSeconds()).padStart(2, '0')}`;
  return `project-${stamp}`;
};

function formatProjectDisplayName(name: string): string {
  const match = /^project\s+(.+)$/.exec(name);
  if (!match) return name;
  const parsed = new Date(match[1]);
  if (Number.isNaN(parsed.getTime())) return name;
  return createChannelName(parsed);
}
