import { type Dispatch, type SetStateAction, useEffect, useState } from 'react';

import { isApplePlatform, primaryModifierPressed, shortcutNumberFromEvent } from '@/lib/keyboard';

interface UseSidebarShortcutsArgs {
  sidebarShortcutActions: (() => void)[];
  showSettings: boolean;
  toggleSettings: () => void;
  setSidebarAutoReveal: Dispatch<SetStateAction<boolean>>;
  setSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
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
  const [shortcutModifierLabel, setShortcutModifierLabel] = useState('⌘');
  const [showSidebarShortcutBadges, setShowSidebarShortcutBadges] = useState(false);

  useEffect(() => {
    const applePlatform = isApplePlatform();
    const primaryModifierKey = applePlatform ? 'Meta' : 'Control';
    setShortcutModifierLabel(applePlatform ? '⌘' : 'Ctrl');

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === primaryModifierKey) setShowSidebarShortcutBadges(true);
      if (!primaryModifierPressed(event, applePlatform) || event.altKey || event.shiftKey) return;

      if (event.key === ',') {
        event.preventDefault();
        toggleSettings();
        return;
      }

      if (showSettings) return;
      const number = shortcutNumberFromEvent(event);
      if (!number) return;
      const action = sidebarShortcutActions[number - 1];
      if (!action) return;
      event.preventDefault();
      setSidebarAutoReveal(false);
      setSidebarCollapsed(false);
      action();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === primaryModifierKey) setShowSidebarShortcutBadges(false);
    };
    const onBlur = () => setShowSidebarShortcutBadges(false);

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [sidebarShortcutActions, showSettings, toggleSettings, setSidebarAutoReveal, setSidebarCollapsed]);

  return { shortcutModifierLabel, showSidebarShortcutBadges };
}
