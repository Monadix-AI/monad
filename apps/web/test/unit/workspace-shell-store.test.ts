import { afterEach, expect, test } from 'bun:test';

import {
  readStoredSidebarCollapsed,
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  useWorkspaceShellStore,
  writeStoredSidebarCollapsed
} from '../../lib/workspace-shell-store';

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

test('temporary sidebar auto reveal does not overwrite stored collapsed preference', () => {
  const values = installLocalStorageMock({ [SIDEBAR_COLLAPSED_STORAGE_KEY]: 'true' });
  useWorkspaceShellStore.setState({ sidebarCollapsed: true, sidebarAutoReveal: false });

  useWorkspaceShellStore.getState().autoRevealSidebar();

  expect(useWorkspaceShellStore.getState().sidebarCollapsed).toBe(false);
  expect(useWorkspaceShellStore.getState().sidebarAutoReveal).toBe(true);
  expect(values.get(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe('true');
});
