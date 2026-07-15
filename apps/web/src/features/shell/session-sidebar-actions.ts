import type { ProjectId, Session, SessionId } from '@monad/protocol';
import type { ProjectItem } from './sidebar/types';

import {
  useCreateWorkplaceProjectMutation,
  useDeleteWorkplaceProjectMutation,
  useUpdateSessionMutation,
  useUpdateWorkplaceProjectMutation
} from '@monad/client-rtk';
import { useCallback, useMemo, useState } from 'react';

interface UseSessionSidebarActionsParams {
  activeProjectId: string | null;
  chatSessions: Pick<Session, 'id' | 'projectId' | 'title'>[];
  onOpenProject: (id: string) => void;
  onOpenWorkspace: () => void;
  projects: ProjectItem[];
}

export function useSessionSidebarActions({
  activeProjectId,
  chatSessions,
  onOpenProject,
  onOpenWorkspace,
  projects
}: UseSessionSidebarActionsParams) {
  const projectActions = useProjectSidebarActions({
    activeProjectId,
    onOpenProject,
    onOpenWorkspace
  });
  const sessionActions = useSidebarSessionActions({
    onOpenWorkspace
  });

  const visibleChatSessions = useMemo(
    () => chatSessions.filter((session) => !sessionActions.pendingArchivedSessionIds.has(session.id)),
    [chatSessions, sessionActions.pendingArchivedSessionIds]
  );

  const visibleProjects = useMemo(
    () =>
      projects.map((project) => ({
        ...project,
        sessions: project.sessions.filter((session) => !sessionActions.pendingArchivedSessionIds.has(session.id))
      })),
    [projects, sessionActions.pendingArchivedSessionIds]
  );

  return {
    ...projectActions,
    archiveChatSession: sessionActions.archiveChatSession,
    archiveProjectSession: sessionActions.archiveProjectSession,
    pendingUnarchivedSessionIds: sessionActions.pendingUnarchivedSessionIds,
    renameSession: sessionActions.renameSession,
    unarchiveSession: sessionActions.unarchiveSession,
    visibleChatSessions,
    visibleProjects
  };
}

function useProjectSidebarActions({
  activeProjectId,
  onOpenProject,
  onOpenWorkspace
}: {
  activeProjectId: string | null;
  onOpenProject: (id: string) => void;
  onOpenWorkspace: () => void;
}) {
  const [createWorkplaceProject] = useCreateWorkplaceProjectMutation();
  const [updateWorkplaceProject] = useUpdateWorkplaceProjectMutation();
  const [deleteWorkplaceProject] = useDeleteWorkplaceProjectMutation();
  const [newProjectDialogOpen, setNewProjectDialogOpen] = useState(false);

  const renameProject = useCallback(
    async (projectId: string, title: string) => {
      await updateWorkplaceProject({ id: projectId as ProjectId, title }).unwrap();
    },
    [updateWorkplaceProject]
  );

  const createProject = useCallback(
    async (args: { cwd?: string; name: string }) => {
      const projectId = await createWorkplaceProject({ cwd: args.cwd, title: args.name }).unwrap();
      setNewProjectDialogOpen(false);
      onOpenProject(projectId);
    },
    [createWorkplaceProject, onOpenProject]
  );

  const deleteProject = useCallback(
    async (projectId: string) => {
      await deleteWorkplaceProject(projectId as ProjectId).unwrap();
      if (activeProjectId === projectId) onOpenWorkspace();
    },
    [activeProjectId, deleteWorkplaceProject, onOpenWorkspace]
  );

  return {
    createProject,
    deleteProject,
    newProjectDialogOpen,
    renameProject,
    setNewProjectDialogOpen
  };
}

function useSidebarSessionActions({ onOpenWorkspace }: { onOpenWorkspace: () => void }) {
  const [updateSession] = useUpdateSessionMutation();
  const [pendingArchivedSessionIds, setPendingArchivedSessionIds] = useState<Set<SessionId>>(() => new Set());
  const [pendingUnarchivedSessionIds, setPendingUnarchivedSessionIds] = useState<Set<SessionId>>(() => new Set());

  const renameSession = useCallback(
    async (sessionId: SessionId, title: string) => {
      await updateSession({ id: sessionId, title }).unwrap();
    },
    [updateSession]
  );

  const revealPendingSessionArchive = useCallback((sessionId: SessionId) => {
    setPendingArchivedSessionIds((current) => {
      if (!current.has(sessionId)) return current;
      const next = new Set(current);
      next.delete(sessionId);
      return next;
    });
  }, []);

  const revealPendingSessionUnarchive = useCallback((sessionId: SessionId) => {
    setPendingUnarchivedSessionIds((current) => {
      if (!current.has(sessionId)) return current;
      const next = new Set(current);
      next.delete(sessionId);
      return next;
    });
  }, []);

  const archiveSession = useCallback(
    ({ afterArchive, sessionId }: { afterArchive?: () => void; sessionId: SessionId }) => {
      revealPendingSessionArchive(sessionId);
      setPendingArchivedSessionIds((current) => new Set(current).add(sessionId));
      void updateSession({ archived: true, id: sessionId })
        .unwrap()
        .then(() => afterArchive?.())
        .catch(() => revealPendingSessionArchive(sessionId));
    },
    [revealPendingSessionArchive, updateSession]
  );

  const unarchiveSession = useCallback(
    (sessionId: SessionId) => {
      revealPendingSessionUnarchive(sessionId);
      setPendingUnarchivedSessionIds((current) => new Set(current).add(sessionId));
      void updateSession({ archived: false, id: sessionId })
        .unwrap()
        .catch(() => revealPendingSessionUnarchive(sessionId));
    },
    [revealPendingSessionUnarchive, updateSession]
  );

  const archiveProjectSession = useCallback(
    (_projectId: string, sessionId: SessionId) => {
      archiveSession({
        afterArchive: () => {
          onOpenWorkspace();
        },
        sessionId
      });
    },
    [archiveSession, onOpenWorkspace]
  );

  const archiveChatSession = useCallback(
    (sessionId: SessionId) => {
      archiveSession({
        afterArchive: () => {
          onOpenWorkspace();
        },
        sessionId
      });
    },
    [archiveSession, onOpenWorkspace]
  );

  return {
    archiveChatSession,
    archiveProjectSession,
    pendingArchivedSessionIds,
    pendingUnarchivedSessionIds,
    renameSession,
    unarchiveSession
  };
}
