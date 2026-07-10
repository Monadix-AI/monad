'use client';

import type { Session, SessionId } from '@monad/protocol';
import type { ReactNode } from 'react';
import type { ProjectItem, TFunction } from './types';

import { createContext, useContext } from 'react';

export const WORKSPACE_SIDEBAR_CONTEXT_GROUPS = ['state', 'actions', 'meta'] as const;

interface WorkspaceSidebarState {
  activeChatSessionId: string | null;
  activeProjectId: string | null;
  activeProjectSessionId: string | null;
  chatSessions: Pick<Session, 'id' | 'title'>[];
  inboxActive?: boolean;
  loading?: boolean;
  projects: ProjectItem[];
}

interface WorkspaceSidebarActions {
  createChatSession: () => void;
  createProject: () => void;
  createProjectSession: (projectId: string) => void;
  deleteChatSession: (sessionId: SessionId) => void | Promise<void>;
  deleteProject: (id: string) => void | Promise<void>;
  deleteProjectSession: (projectId: string, sessionId: SessionId) => void | Promise<void>;
  openInbox: () => void;
  openProject: (id: string) => void;
  openProjectSession: (projectId: string, sessionId: SessionId) => void;
  openProjectSettings: (id: string) => void;
  openSession: (sessionId: SessionId) => void;
  renameProject: (id: string, title: string) => void | Promise<void>;
  renameSession: (sessionId: SessionId, title: string) => void | Promise<void>;
  toggleSessionPinned: (id: SessionId) => void;
}

interface WorkspaceSidebarMeta {
  shortcutModifierLabel?: string;
  showShortcutBadges?: boolean;
  t: TFunction;
}

export interface WorkspaceSidebarContextValue {
  actions: WorkspaceSidebarActions;
  meta: WorkspaceSidebarMeta;
  state: WorkspaceSidebarState;
}

const WorkspaceSidebarContext = createContext<WorkspaceSidebarContextValue | null>(null);

export function WorkspaceSidebarProvider({
  children,
  value
}: {
  children: ReactNode;
  value: WorkspaceSidebarContextValue;
}) {
  return <WorkspaceSidebarContext value={value}>{children}</WorkspaceSidebarContext>;
}

export function useWorkspaceSidebar(): WorkspaceSidebarContextValue {
  const value = useContext(WorkspaceSidebarContext);
  if (!value) throw new Error('useWorkspaceSidebar must be used within WorkspaceSidebarProvider');
  return value;
}
