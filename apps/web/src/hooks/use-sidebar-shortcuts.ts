import { matchesKeyboardEvent } from '@tanstack/hotkeys';
import { useKeyHold } from '@tanstack/react-hotkeys';
import { useEffect, useMemo } from 'react';

import { isApplePlatform } from '#/lib/keyboard';
import { useWorkspaceShellStore } from '#/lib/workspace-shell-store';

interface UseSidebarShortcutsArgs {
  inboxShortcutAction?: () => void;
  newChatShortcutAction?: () => void;
  sidebarShortcutActions: (() => void)[];
  showSettings: boolean;
  toggleSettings: () => void;
  revealSidebar?: () => void;
}

export const settingsHotkey = 'Mod+,' as const;
export const newChatHotkey = 'Mod+`' as const;
export const inboxHotkey = 'Mod+I' as const;
export const sidebarNumberHotkeys = [
  'Mod+1',
  'Mod+2',
  'Mod+3',
  'Mod+4',
  'Mod+5',
  'Mod+6',
  'Mod+7',
  'Mod+8',
  'Mod+9'
] as const;

export const sidebarShortcutListenerOptions = { capture: true, passive: false } as const;
const sidebarSessionSelector = '[data-sidebar-session-row="true"]';

export function createVisibleSidebarSessionShortcutActions(
  activate: (index: number) => boolean = activateVisibleSidebarSession
): (() => void)[] {
  return sidebarNumberHotkeys.map((_, index) => () => {
    activate(index);
  });
}

export function visibleSidebarSessionRows(root: Pick<Document, 'querySelectorAll'>): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(sidebarSessionSelector)).filter(
    (row) => !row.closest('[inert]')
  );
}

export function activateVisibleSidebarSession(
  index: number,
  root: Pick<Document, 'querySelectorAll'> = document
): boolean {
  const row = visibleSidebarSessionRows(root)[index];
  if (!row) return false;
  row.click();
  return true;
}

export function syncVisibleSidebarSessionShortcutBadges(
  modifierLabel: string | null,
  root: Pick<Document, 'querySelectorAll'> = document
): void {
  const rows = Array.from(root.querySelectorAll<HTMLElement>(sidebarSessionSelector));
  for (const row of rows) {
    delete row.dataset.sidebarShortcut;
    delete row.dataset.sidebarShortcutModifier;
  }
  if (!modifierLabel) return;
  for (const [index, row] of visibleSidebarSessionRows(root).slice(0, sidebarNumberHotkeys.length).entries()) {
    row.dataset.sidebarShortcut = String(index + 1);
    row.dataset.sidebarShortcutModifier = modifierLabel;
  }
}

function matchesNewChatHotkey(event: KeyboardEvent, applePlatform: boolean) {
  const hasModifier = applePlatform ? event.metaKey : event.ctrlKey;
  return hasModifier && !event.altKey && !event.shiftKey && (event.key === '`' || event.code === 'Backquote');
}

function consumeSidebarShortcutEvent(event: KeyboardEvent) {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

export function createSidebarShortcutHandler({
  inboxShortcutAction,
  newChatShortcutAction,
  sidebarShortcutActions,
  showSettings,
  toggleSettings,
  revealSidebar,
  applePlatform
}: UseSidebarShortcutsArgs & { applePlatform: boolean }) {
  const platform = applePlatform ? 'mac' : 'windows';
  return (event: KeyboardEvent) => {
    if (event.isComposing) return;

    if (matchesKeyboardEvent(event, settingsHotkey, platform)) {
      consumeSidebarShortcutEvent(event);
      toggleSettings();
      return;
    }

    if (newChatShortcutAction && matchesNewChatHotkey(event, applePlatform)) {
      consumeSidebarShortcutEvent(event);
      revealSidebar?.();
      newChatShortcutAction();
      return;
    }

    if (inboxShortcutAction && matchesKeyboardEvent(event, inboxHotkey, platform)) {
      consumeSidebarShortcutEvent(event);
      revealSidebar?.();
      inboxShortcutAction();
      return;
    }

    if (showSettings) return;
    const shortcutIndex = sidebarNumberHotkeys.findIndex((hotkey) => matchesKeyboardEvent(event, hotkey, platform));
    if (shortcutIndex < 0) return;
    const action = sidebarShortcutActions[shortcutIndex];
    if (!action) return;

    consumeSidebarShortcutEvent(event);
    revealSidebar?.();
    action();
  };
}

// Global primary-modifier shortcuts cover settings, New chat, Inbox, and numbered sidebar navigation.
// Holding the modifier reveals the numbered badges so the bindings are discoverable.
export function useSidebarShortcuts({
  inboxShortcutAction,
  newChatShortcutAction,
  sidebarShortcutActions,
  showSettings,
  toggleSettings
}: UseSidebarShortcutsArgs) {
  const applePlatform = useMemo(() => isApplePlatform(), []);
  const shortcutModifierLabel = applePlatform ? '⌘' : 'Ctrl';
  const showSidebarShortcutBadges = useKeyHold(applePlatform ? 'Meta' : 'Control');
  const revealSidebar = useWorkspaceShellStore((state) => state.revealSidebar);

  const shortcutHandler = useMemo(
    () =>
      createSidebarShortcutHandler({
        inboxShortcutAction,
        sidebarShortcutActions,
        newChatShortcutAction,
        showSettings,
        toggleSettings,
        revealSidebar,
        applePlatform
      }),
    [
      sidebarShortcutActions,
      inboxShortcutAction,
      newChatShortcutAction,
      showSettings,
      toggleSettings,
      revealSidebar,
      applePlatform
    ]
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.addEventListener('keydown', shortcutHandler, sidebarShortcutListenerOptions);
    return () => window.removeEventListener('keydown', shortcutHandler, sidebarShortcutListenerOptions);
  }, [shortcutHandler]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const syncBadges = () =>
      syncVisibleSidebarSessionShortcutBadges(showSidebarShortcutBadges ? shortcutModifierLabel : null);
    syncBadges();
    if (!showSidebarShortcutBadges || typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(syncBadges);
    observer.observe(document.body, { attributeFilter: ['inert'], attributes: true, childList: true, subtree: true });
    return () => {
      observer.disconnect();
      syncVisibleSidebarSessionShortcutBadges(null);
    };
  }, [shortcutModifierLabel, showSidebarShortcutBadges]);

  return { shortcutModifierLabel, showSidebarShortcutBadges };
}
