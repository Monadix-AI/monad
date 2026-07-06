import { matchesKeyboardEvent } from '@tanstack/hotkeys';
import { useKeyHold } from '@tanstack/react-hotkeys';
import { useEffect, useMemo } from 'react';

import { isApplePlatform } from '@/lib/keyboard';
import { useWorkspaceShellStore } from '@/lib/workspace-shell-store';

interface UseSidebarShortcutsArgs {
  monadAgentShortcutAction?: () => void;
  sidebarShortcutActions: (() => void)[];
  showSettings: boolean;
  toggleSettings: () => void;
  revealSidebar?: () => void;
}

export const settingsHotkey = 'Mod+,' as const;
export const monadAgentHotkey = 'Mod+`' as const;
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

export const sidebarShortcutListenerOptions = { capture: true } as const;

function matchesMonadAgentHotkey(event: KeyboardEvent, applePlatform: boolean) {
  const hasModifier = applePlatform ? event.metaKey : event.ctrlKey;
  return hasModifier && !event.altKey && !event.shiftKey && (event.key === '`' || event.code === 'Backquote');
}

export function createSidebarShortcutHandler({
  monadAgentShortcutAction,
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
      event.preventDefault();
      toggleSettings();
      return;
    }

    if (showSettings) return;
    if (monadAgentShortcutAction && matchesMonadAgentHotkey(event, applePlatform)) {
      event.preventDefault();
      revealSidebar?.();
      monadAgentShortcutAction();
      return;
    }

    const shortcutIndex = sidebarNumberHotkeys.findIndex((hotkey) => matchesKeyboardEvent(event, hotkey, platform));
    if (shortcutIndex < 0) return;
    const action = sidebarShortcutActions[shortcutIndex];
    if (!action) return;

    event.preventDefault();
    revealSidebar?.();
    action();
  };
}

// Global primary-modifier shortcuts: comma toggles settings, backquote opens Monad Agent, 1..9 jumps to a sidebar pile.
// Holding the modifier reveals the numbered badges so the bindings are discoverable.
export function useSidebarShortcuts({
  monadAgentShortcutAction,
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
        sidebarShortcutActions,
        monadAgentShortcutAction,
        showSettings,
        toggleSettings,
        revealSidebar,
        applePlatform
      }),
    [sidebarShortcutActions, monadAgentShortcutAction, showSettings, toggleSettings, revealSidebar, applePlatform]
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.addEventListener('keydown', shortcutHandler, sidebarShortcutListenerOptions);
    return () => window.removeEventListener('keydown', shortcutHandler, sidebarShortcutListenerOptions);
  }, [shortcutHandler]);

  return { shortcutModifierLabel, showSidebarShortcutBadges };
}
