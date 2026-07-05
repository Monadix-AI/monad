import type { NativeCliSessionView, WorkplaceProject } from '@monad/protocol';

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
  pinned: boolean;
  unreadCount: number;
}

export interface BuildWorkspaceProjectsOptions {
  liveNativeCliSessions?: readonly NativeCliSessionView[];
  nativeCliSessions?: readonly NativeCliSessionView[];
  pinnedProjectIds?: ReadonlySet<string>;
}

export const buildWorkspaceProjects = (
  projects: Pick<WorkplaceProject, 'id' | 'title' | 'cwd'>[] = [],
  options: BuildWorkspaceProjectsOptions = {}
): WorkspaceProjectListItem[] => {
  const activityByProjectId = projectActivityById({
    liveNativeCliSessions: options.liveNativeCliSessions ?? [],
    nativeCliSessions: options.nativeCliSessions ?? options.liveNativeCliSessions ?? []
  });
  return projects
    .map((project, index) => {
      const activity = activityByProjectId.get(project.id);
      return {
        id: project.id,
        name: getWorkplaceProjectName(project),
        cwd: project.cwd,
        hasRunningAgent: activity?.hasRunningAgent ?? false,
        pinned: options.pinnedProjectIds?.has(project.id) ?? false,
        unreadCount: activity?.unreadCount ?? 0,
        index
      };
    })
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.index - b.index)
    .map(({ index: _index, ...project }) => project);
};

function projectActivityById({
  liveNativeCliSessions,
  nativeCliSessions
}: {
  liveNativeCliSessions: readonly NativeCliSessionView[];
  nativeCliSessions: readonly NativeCliSessionView[];
}) {
  const activity = new Map<string, { hasRunningAgent: boolean; unreadCount: number }>();
  for (const session of nativeCliSessions) {
    const current = activity.get(session.transcriptTargetId) ?? { hasRunningAgent: false, unreadCount: 0 };
    current.unreadCount +=
      Math.max(0, session.lastDeliveredSeq - session.lastVisibleSeq) + session.pendingApprovalCount;
    activity.set(session.transcriptTargetId, current);
  }
  for (const session of liveNativeCliSessions) {
    const current = activity.get(session.transcriptTargetId) ?? { hasRunningAgent: false, unreadCount: 0 };
    current.hasRunningAgent ||= session.state === 'starting' || session.state === 'running';
    activity.set(session.transcriptTargetId, current);
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
