import type { ProjectId, Session, SessionId } from '@monad/protocol';
import type { ProjectItem, TFunction } from './sidebar/types';

import {
  useCreateWorkplaceProjectMutation,
  useDeleteSessionMutation,
  useDeleteWorkplaceProjectMutation,
  useUndoDeleteSessionMutation,
  useUpdateSessionMutation,
  useUpdateWorkplaceProjectMutation
} from '@monad/client-rtk';
import { useCallback, useMemo, useState } from 'react';

import { toast } from '#/components/ToastProvider';

const SESSION_DELETE_UNDO_MS = 5000;

interface UseSessionSidebarActionsParams {
  activeProjectId: string | null;
  chatSessions: Pick<Session, 'id' | 'projectId' | 'title'>[];
  onOpenProject: (id: string) => void;
  onOpenWorkspace: () => void;
  projects: ProjectItem[];
  t: TFunction;
}

export function useSessionSidebarActions({
  activeProjectId,
  chatSessions,
  onOpenProject,
  onOpenWorkspace,
  projects,
  t
}: UseSessionSidebarActionsParams) {
  const projectActions = useProjectSidebarActions({
    activeProjectId,
    onOpenProject,
    onOpenWorkspace
  });
  const sessionActions = useSidebarSessionActions({
    chatSessions,
    onOpenWorkspace,
    projects,
    t
  });

  const visibleChatSessions = useMemo(
    () => chatSessions.filter((session) => !sessionActions.pendingDeletedSessionIds.has(session.id)),
    [chatSessions, sessionActions.pendingDeletedSessionIds]
  );

  const visibleProjects = useMemo(
    () =>
      projects.map((project) => ({
        ...project,
        sessions: project.sessions.filter((session) => !sessionActions.pendingDeletedSessionIds.has(session.id))
      })),
    [projects, sessionActions.pendingDeletedSessionIds]
  );

  return {
    ...projectActions,
    deleteChatSession: sessionActions.deleteChatSession,
    deleteProjectSession: sessionActions.deleteProjectSession,
    renameSession: sessionActions.renameSession,
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

function useSidebarSessionActions({
  chatSessions,
  onOpenWorkspace,
  projects,
  t
}: {
  chatSessions: Pick<Session, 'id' | 'projectId' | 'title'>[];
  onOpenWorkspace: () => void;
  projects: ProjectItem[];
  t: TFunction;
}) {
  const [updateSession] = useUpdateSessionMutation();
  const [deleteSession] = useDeleteSessionMutation();
  const [undoDeleteSession] = useUndoDeleteSessionMutation();
  const [pendingDeletedSessionIds, setPendingDeletedSessionIds] = useState<Set<SessionId>>(() => new Set());

  const renameSession = useCallback(
    async (sessionId: SessionId, title: string) => {
      await updateSession({ id: sessionId, title }).unwrap();
    },
    [updateSession]
  );

  const revealPendingSessionDelete = useCallback((sessionId: SessionId) => {
    setPendingDeletedSessionIds((current) => {
      if (!current.has(sessionId)) return current;
      const next = new Set(current);
      next.delete(sessionId);
      return next;
    });
  }, []);

  const queueSessionDelete = useCallback(
    ({ afterDelete, sessionId, title }: { afterDelete?: () => void; sessionId: SessionId; title: string }) => {
      revealPendingSessionDelete(sessionId);
      setPendingDeletedSessionIds((current) => new Set(current).add(sessionId));
      void deleteSession(sessionId)
        .unwrap()
        .then(() => afterDelete?.())
        .catch(() => revealPendingSessionDelete(sessionId));
      toast.undo(t('web.sidebar.sessionDeleteQueued', { name: title }), {
        action: {
          label: t('web.sidebar.undoDelete'),
          onClick: async () => {
            revealPendingSessionDelete(sessionId);
            await undoDeleteSession(sessionId)
              .unwrap()
              .catch(() => undefined);
          }
        },
        duration: SESSION_DELETE_UNDO_MS,
        onExpire: () => {
          revealPendingSessionDelete(sessionId);
          void deleteSession(sessionId)
            .unwrap()
            .catch(() => undefined);
          afterDelete?.();
        },
        onPause: () => {
          void undoDeleteSession(sessionId)
            .unwrap()
            .catch(() => undefined);
        }
      });
    },
    [deleteSession, revealPendingSessionDelete, t, undoDeleteSession]
  );

  const deleteProjectSession = useCallback(
    (projectId: string, sessionId: SessionId) => {
      const title =
        projects.find((project) => project.id === projectId)?.sessions.find((session) => session.id === sessionId)
          ?.title ?? t('web.sidebar.session');
      queueSessionDelete({
        afterDelete: () => {
          onOpenWorkspace();
        },
        sessionId,
        title
      });
    },
    [onOpenWorkspace, projects, queueSessionDelete, t]
  );

  const deleteChatSession = useCallback(
    (sessionId: SessionId) => {
      const title = chatSessions.find((session) => session.id === sessionId)?.title ?? t('web.sidebar.session');
      queueSessionDelete({
        afterDelete: () => {
          onOpenWorkspace();
        },
        sessionId,
        title
      });
    },
    [chatSessions, onOpenWorkspace, queueSessionDelete, t]
  );

  return {
    deleteChatSession,
    deleteProjectSession,
    pendingDeletedSessionIds,
    renameSession
  };
}
