import { afterEach, expect, test } from 'bun:test';

import {
  readStoredSidebarCollapsed,
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  useWorkspaceShellStore,
  writeStoredSidebarCollapsed
} from '../../src/lib/workspace-shell-store';

const originalWindow = globalThis.window;

function installLocalStorageMock(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          values.set(key, value);
        }
      }
    }
  });
  return values;
}

afterEach(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow
  });
});

test('sidebar collapsed preference reads from localStorage', () => {
  installLocalStorageMock({ [SIDEBAR_COLLAPSED_STORAGE_KEY]: 'true' });

  expect(readStoredSidebarCollapsed()).toBe(true);
});

test('sidebar collapsed preference persists explicit open and closed states', () => {
  const values = installLocalStorageMock();

  writeStoredSidebarCollapsed(true);
  expect(values.get(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe('true');

  writeStoredSidebarCollapsed(false);
  expect(values.get(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe('false');
});

test('sidebar collapsed preference falls back open when storage is unavailable', () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: undefined
  });

  expect(readStoredSidebarCollapsed()).toBe(false);
});

test('shell store remembers Studio and workspace navigation preferences', () => {
  const values = installLocalStorageMock();
  useWorkspaceShellStore.setState({
    lastStudioSection: 'runtime',
    lastWorkspacePath: '/'
  });

  useWorkspaceShellStore.getState().rememberStudioSection('capabilities');
  useWorkspaceShellStore.getState().rememberWorkspacePath('/sessions/session-1');

  expect(useWorkspaceShellStore.getState().lastStudioSection).toBe('capabilities');
  expect(useWorkspaceShellStore.getState().lastWorkspacePath).toBe('/sessions/session-1');
  expect([...values.entries()]).toEqual([]);
});

test('temporary sidebar auto reveal does not overwrite stored collapsed preference', () => {
  const values = installLocalStorageMock({ [SIDEBAR_COLLAPSED_STORAGE_KEY]: 'true' });
  useWorkspaceShellStore.setState({ sidebarCollapsed: true, sidebarAutoReveal: false });

  useWorkspaceShellStore.getState().autoRevealSidebar();

  expect(useWorkspaceShellStore.getState().sidebarCollapsed).toBe(false);
  expect(useWorkspaceShellStore.getState().sidebarAutoReveal).toBe(true);
  expect(values.get(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe('true');
});

test('active project session holds reverse-sync data only (no callbacks) and clears on openWorkspace', () => {
  useWorkspaceShellStore.setState({ activeProjectSession: null });

  useWorkspaceShellStore.getState().setActiveProjectSession({
    activeSessionId: 'ses_ACTIVE000000' as never,
    projectId: 'prj_ACTIVE000000'
  });

  expect(useWorkspaceShellStore.getState().activeProjectSession).toEqual({
    activeSessionId: 'ses_ACTIVE000000',
    projectId: 'prj_ACTIVE000000'
  });

  useWorkspaceShellStore.getState().openWorkspace();

  expect(useWorkspaceShellStore.getState().activeProjectSession).toBeNull();
});

test('new session project selection remains in the shell store until another target replaces it', () => {
  useWorkspaceShellStore.getState().setNewSessionProjectId('prj_SELECTED0000');

  expect(useWorkspaceShellStore.getState().newSessionProjectId).toBe('prj_SELECTED0000');

  useWorkspaceShellStore.getState().openWorkspace();
  expect(useWorkspaceShellStore.getState().newSessionProjectId).toBe('prj_SELECTED0000');

  useWorkspaceShellStore.getState().setNewSessionProjectId(null);
  expect(useWorkspaceShellStore.getState().newSessionProjectId).toBeNull();
});

test('draft chat sessions remain until the server session list confirms the same id', () => {
  const createdAt = '2026-07-28T10:00:00.000Z';
  useWorkspaceShellStore.setState({
    draftChatSessions: [
      {
        attachments: [],
        createdAt,
        createIdempotencyKey: 'idem_CREATE000000' as never,
        id: 'ses_CONFIRMED0000' as never,
        sendIdempotencyKey: 'idem_SEND00000000' as never,
        status: 'creating',
        text: 'confirmed',
        title: 'Confirmed',
        updatedAt: createdAt
      },
      {
        attachments: [],
        createdAt,
        createIdempotencyKey: 'idem_CREATE111111' as never,
        id: 'ses_PENDING000000' as never,
        sendIdempotencyKey: 'idem_SEND11111111' as never,
        status: 'creating',
        text: 'pending',
        title: 'Pending',
        updatedAt: createdAt
      }
    ]
  });

  useWorkspaceShellStore.getState().reconcileDraftChatSessions(['ses_CONFIRMED0000' as never]);

  expect(useWorkspaceShellStore.getState().draftChatSessions.map((session) => session.id)).toEqual([
    'ses_PENDING000000'
  ]);
});

test('right panel open state toggles and resolves through explicit open/close', () => {
  installLocalStorageMock();

  expect(useWorkspaceShellStore.getState().rightPanelOpen).toBe(false);

  useWorkspaceShellStore.getState().toggleRightPanel();
  expect(useWorkspaceShellStore.getState().rightPanelOpen).toBe(true);

  useWorkspaceShellStore.getState().toggleRightPanel();
  expect(useWorkspaceShellStore.getState().rightPanelOpen).toBe(false);

  useWorkspaceShellStore.getState().openRightPanel();
  expect(useWorkspaceShellStore.getState().rightPanelOpen).toBe(true);

  useWorkspaceShellStore.getState().closeRightPanel();
  expect(useWorkspaceShellStore.getState().rightPanelOpen).toBe(false);
});

test('toggling a right panel view opens it, re-toggling the same view closes it, and switching views keeps the panel open', () => {
  installLocalStorageMock();
  useWorkspaceShellStore.setState({ rightPanelOpen: false, rightPanelView: 'inspector' });

  useWorkspaceShellStore.getState().toggleRightPanelView('plan');
  expect(useWorkspaceShellStore.getState()).toMatchObject({ rightPanelOpen: true, rightPanelView: 'plan' });

  // Toggling the currently-open view closes the panel.
  useWorkspaceShellStore.getState().toggleRightPanelView('plan');
  expect(useWorkspaceShellStore.getState().rightPanelOpen).toBe(false);

  useWorkspaceShellStore.getState().toggleRightPanelView('plan');
  // Switching to a different view while open replaces the view without closing the panel.
  useWorkspaceShellStore.getState().toggleRightPanelView('inspector');
  expect(useWorkspaceShellStore.getState()).toMatchObject({ rightPanelOpen: true, rightPanelView: 'inspector' });
});
