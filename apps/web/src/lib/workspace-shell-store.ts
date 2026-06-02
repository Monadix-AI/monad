import type { AgentId, IdempotencyKey, SendMessageAttachment, SessionId } from '@monad/protocol';
import type { StudioSectionId } from '#/features/studio/sections';

import { create } from 'zustand';

import { isWorkspacePath } from '#/features/shell/routing/paths';
import { DEFAULT_STUDIO_SECTION } from '#/features/studio/sections';

// Reverse-sync data only (URL follows a project's internal active-session change).
// No callbacks live in the store; forward switching is URL-driven (routed session id).
type ActiveProjectSessionState = {
  activeSessionId: SessionId | null;
  projectId: string;
};

type NewChatPrefill =
  | { mode: 'agent' }
  | {
      mode: 'project';
      projectId: string;
    };

export interface DraftChatSession {
  agentId?: AgentId;
  attachments: SendMessageAttachment[];
  createdAt: string;
  createIdempotencyKey: IdempotencyKey;
  errorMessage?: string;
  id: SessionId;
  sendIdempotencyKey: IdempotencyKey;
  serverSessionId?: SessionId;
  status: 'creating' | 'failed';
  text: string;
  title: string;
  updatedAt: string;
}

export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'monad:sidebarCollapsed';
const PINNED_SESSIONS_STORAGE_KEY = 'monad:pinnedSessions';

function shellStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readStoredSidebarCollapsed(): boolean {
  return shellStorage()?.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true';
}

export function writeStoredSidebarCollapsed(collapsed: boolean): void {
  try {
    shellStorage()?.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(collapsed));
  } catch {
    // Local UI preference only; ignore private-mode/quota failures.
  }
}

function readStoredPinnedSessionIds(): string[] {
  const raw = shellStorage()?.getItem(PINNED_SESSIONS_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === 'string' && value.length > 0);
  } catch {
    return [];
  }
}

function writeStoredPinnedSessionIds(sessionIds: readonly string[]): void {
  try {
    shellStorage()?.setItem(PINNED_SESSIONS_STORAGE_KEY, JSON.stringify([...sessionIds]));
  } catch {
    // Local UI preference only; ignore private-mode/quota failures.
  }
}

type RightPanelView = 'inspector' | 'plan';

export interface WorkspaceShellState {
  lastStudioSection: StudioSectionId;
  lastWorkspacePath: string;
  lastMonadSessionId: SessionId | null;
  settingsReturnPathState: string | null;
  activeProjectSession: ActiveProjectSessionState | null;
  sidebarCollapsed: boolean;
  sidebarAutoReveal: boolean;
  pinnedSessionIds: string[];
  draftChatSessions: DraftChatSession[];
  newChatPrefill: NewChatPrefill | null;
  newProjectOpen: boolean;
  rightPanelOpen: boolean;
  rightPanelView: RightPanelView;
  rememberStudioSection: (section: StudioSectionId) => void;
  rememberWorkspacePath: (path: string) => void;
  rememberMonadSession: (sessionId: SessionId | null) => void;
  setSettingsReturnPathState: (path: string | null) => void;
  openWorkspace: () => void;
  openMonadChat: () => void;
  setActiveProjectSession: (state: ActiveProjectSessionState | null) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebarCollapsed: () => void;
  revealSidebar: () => void;
  autoRevealSidebar: () => void;
  collapseSidebar: () => void;
  toggleSessionPinned: (sessionId: SessionId) => void;
  addDraftChatSession: (draft: DraftChatSession) => void;
  failDraftChatSession: (sessionId: SessionId, message: string) => void;
  removeDraftChatSession: (sessionId: SessionId) => void;
  reconcileDraftChatSessions: (serverSessionIds: readonly SessionId[]) => void;
  setNewChatPrefill: (prefill: NewChatPrefill | null) => void;
  setNewProjectOpen: (open: boolean) => void;
  openRightPanel: () => void;
  closeRightPanel: () => void;
  toggleRightPanel: () => void;
  toggleRightPanelView: (view: RightPanelView) => void;
}

export const useWorkspaceShellStore = create<WorkspaceShellState>()((set) => ({
  lastStudioSection: DEFAULT_STUDIO_SECTION,
  lastWorkspacePath: '/',
  lastMonadSessionId: null,
  settingsReturnPathState: null,
  activeProjectSession: null,
  sidebarCollapsed: readStoredSidebarCollapsed(),
  sidebarAutoReveal: false,
  pinnedSessionIds: readStoredPinnedSessionIds(),
  draftChatSessions: [],
  newChatPrefill: null,
  newProjectOpen: false,
  rightPanelOpen: false,
  rightPanelView: 'inspector',
  rememberStudioSection: (section) => {
    set({ lastStudioSection: section });
  },
  rememberWorkspacePath: (path) => {
    if (!isWorkspacePath(path)) return;
    set({ lastWorkspacePath: path });
  },
  rememberMonadSession: (sessionId) => set({ lastMonadSessionId: sessionId }),
  setSettingsReturnPathState: (path) => set({ settingsReturnPathState: path }),
  // Clear the reverse-sync active-session data when leaving a project for the agent/workspace.
  openWorkspace: () => set({ activeProjectSession: null }),
  openMonadChat: () => set({ activeProjectSession: null }),
  setActiveProjectSession: (state) => set({ activeProjectSession: state }),
  setSidebarCollapsed: (collapsed) => {
    writeStoredSidebarCollapsed(collapsed);
    set({ sidebarCollapsed: collapsed, sidebarAutoReveal: false });
  },
  toggleSidebarCollapsed: () =>
    set((state) => {
      const sidebarCollapsed = !state.sidebarCollapsed;
      writeStoredSidebarCollapsed(sidebarCollapsed);
      return { sidebarCollapsed, sidebarAutoReveal: false };
    }),
  revealSidebar: () => {
    writeStoredSidebarCollapsed(false);
    set({ sidebarCollapsed: false, sidebarAutoReveal: false });
  },
  autoRevealSidebar: () => set({ sidebarCollapsed: false, sidebarAutoReveal: true }),
  collapseSidebar: () => {
    writeStoredSidebarCollapsed(true);
    set({ sidebarCollapsed: true, sidebarAutoReveal: false });
  },
  toggleSessionPinned: (sessionId) =>
    set((state) => {
      const pinned = new Set(state.pinnedSessionIds);
      if (pinned.has(sessionId)) pinned.delete(sessionId);
      else pinned.add(sessionId);
      const pinnedSessionIds = [...pinned];
      writeStoredPinnedSessionIds(pinnedSessionIds);
      return { pinnedSessionIds };
    }),
  addDraftChatSession: (draft) =>
    set((state) => ({
      draftChatSessions: [draft, ...state.draftChatSessions.filter((session) => session.id !== draft.id)]
    })),
  failDraftChatSession: (sessionId, message) =>
    set((state) => ({
      draftChatSessions: state.draftChatSessions.map((session) =>
        session.id === sessionId
          ? { ...session, status: 'failed', errorMessage: message, updatedAt: new Date().toISOString() }
          : session
      )
    })),
  removeDraftChatSession: (sessionId) =>
    set((state) => ({
      draftChatSessions: state.draftChatSessions.filter((session) => session.id !== sessionId)
    })),
  reconcileDraftChatSessions: (serverSessionIds) => {
    const confirmed = new Set(serverSessionIds);
    set((state) => {
      const draftChatSessions = state.draftChatSessions.filter((session) => !confirmed.has(session.id));
      return draftChatSessions.length === state.draftChatSessions.length ? state : { draftChatSessions };
    });
  },
  setNewChatPrefill: (prefill) => set({ newChatPrefill: prefill }),
  setNewProjectOpen: (open) => set({ newProjectOpen: open }),
  openRightPanel: () => set({ rightPanelOpen: true }),
  closeRightPanel: () => set({ rightPanelOpen: false }),
  toggleRightPanel: () => set((state) => ({ rightPanelOpen: !state.rightPanelOpen })),
  toggleRightPanelView: (view) =>
    set((state) =>
      state.rightPanelOpen && state.rightPanelView === view
        ? { rightPanelOpen: false }
        : { rightPanelOpen: true, rightPanelView: view }
    )
}));
