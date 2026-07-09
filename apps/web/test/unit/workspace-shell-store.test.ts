import { afterEach, expect, test } from 'bun:test';

import {
  LAST_STUDIO_SECTION_STORAGE_KEY,
  LAST_WORKSPACE_PATH_STORAGE_KEY,
  readStoredLastStudioSection,
  readStoredLastWorkspacePath,
  readStoredSidebarCollapsed,
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  useWorkspaceShellStore,
  writeStoredLastStudioSection,
  writeStoredLastWorkspacePath,
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

test('last Studio section defaults to runtime and persists valid sections', () => {
  const values = installLocalStorageMock({ [LAST_STUDIO_SECTION_STORAGE_KEY]: 'not-a-section' });

  expect(readStoredLastStudioSection()).toBe('runtime');

  writeStoredLastStudioSection('models');

  expect(values.get(LAST_STUDIO_SECTION_STORAGE_KEY)).toBe('models');
  expect(readStoredLastStudioSection()).toBe('models');
});

test('last workspace path persists only canonical workspace routes', () => {
  const values = installLocalStorageMock({ [LAST_WORKSPACE_PATH_STORAGE_KEY]: '/channels/old' });

  expect(readStoredLastWorkspacePath()).toBe('/');

  writeStoredLastWorkspacePath('/workspace/prj_ABCDEF123456/ses_UVWXYZ789012');
  expect(values.get(LAST_WORKSPACE_PATH_STORAGE_KEY)).toBe('/workspace/prj_ABCDEF123456/ses_UVWXYZ789012');
  expect(readStoredLastWorkspacePath()).toBe('/workspace/prj_ABCDEF123456/ses_UVWXYZ789012');

  writeStoredLastWorkspacePath('/studio/models');
  expect(values.get(LAST_WORKSPACE_PATH_STORAGE_KEY)).toBe('/workspace/prj_ABCDEF123456/ses_UVWXYZ789012');
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
  expect(values.get(LAST_STUDIO_SECTION_STORAGE_KEY)).toBe('capabilities');
  expect(values.get(LAST_WORKSPACE_PATH_STORAGE_KEY)).toBe('/sessions/session-1');
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
