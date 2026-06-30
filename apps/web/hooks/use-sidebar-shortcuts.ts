import { matchesKeyboardEvent } from '@tanstack/hotkeys';
import { useKeyHold } from '@tanstack/react-hotkeys';
import { type Dispatch, type SetStateAction, useEffect, useMemo } from 'react';

import { isApplePlatform } from '@/lib/keyboard';

interface UseSidebarShortcutsArgs {
  sidebarShortcutActions: (() => void)[];
  showSettings: boolean;
  toggleSettings: () => void;
  setSidebarAutoReveal: Dispatch<SetStateAction<boolean>>;
  setSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
}

export const settingsHotkey = 'Mod+,' as const;
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

export function createSidebarShortcutHandler({
  sidebarShortcutActions,
  showSettings,
  toggleSettings,
  setSidebarAutoReveal,
  setSidebarCollapsed,
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
    const shortcutIndex = sidebarNumberHotkeys.findIndex((hotkey) => matchesKeyboardEvent(event, hotkey, platform));
    if (shortcutIndex < 0) return;
    const action = sidebarShortcutActions[shortcutIndex];
    if (!action) return;

    event.preventDefault();
    setSidebarAutoReveal(false);
    setSidebarCollapsed(false);
    action();
  };
}

// Global primary-modifier shortcuts: `⌘,` toggles settings, `⌘1..9` jumps to a sidebar pile.
// Holding the modifier reveals the numbered badges so the bindings are discoverable.
export function useSidebarShortcuts({
  sidebarShortcutActions,
  showSettings,
  toggleSettings,
  setSidebarAutoReveal,
  setSidebarCollapsed
}: UseSidebarShortcutsArgs) {
  const applePlatform = useMemo(() => isApplePlatform(), []);
  const shortcutModifierLabel = applePlatform ? '⌘' : 'Ctrl';
  const showSidebarShortcutBadges = useKeyHold(applePlatform ? 'Meta' : 'Control');

  const shortcutHandler = useMemo(
    () =>
      createSidebarShortcutHandler({
        sidebarShortcutActions,
        showSettings,
        toggleSettings,
        setSidebarAutoReveal,
        setSidebarCollapsed,
        applePlatform
      }),
    [sidebarShortcutActions, showSettings, toggleSettings, setSidebarAutoReveal, setSidebarCollapsed, applePlatform]
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.addEventListener('keydown', shortcutHandler, sidebarShortcutListenerOptions);
    return () => window.removeEventListener('keydown', shortcutHandler, sidebarShortcutListenerOptions);
  }, [shortcutHandler]);

  return { shortcutModifierLabel, showSidebarShortcutBadges };
}
