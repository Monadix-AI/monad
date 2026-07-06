import { expect, test } from 'bun:test';

import {
  createSidebarShortcutHandler,
  monadAgentHotkey,
  settingsHotkey,
  sidebarNumberHotkeys,
  sidebarShortcutListenerOptions
} from '../../hooks/use-sidebar-shortcuts.ts';

function shortcutEvent(init: {
  altKey?: boolean;
  code?: string;
  ctrlKey?: boolean;
  isComposing?: boolean;
  key: string;
  metaKey?: boolean;
  shiftKey?: boolean;
}) {
  let prevented = 0;
  let stopped = 0;
  const event = {
    altKey: init.altKey ?? false,
    code: init.code ?? '',
    ctrlKey: init.ctrlKey ?? false,
    isComposing: init.isComposing ?? false,
    key: init.key,
    metaKey: init.metaKey ?? false,
    shiftKey: init.shiftKey ?? false,
    preventDefault: () => {
      prevented += 1;
    },
    stopPropagation: () => {
      stopped += 1;
    }
  } as KeyboardEvent;

  return {
    event,
    prevented: () => prevented,
    stopped: () => stopped
  };
}

test('sidebar hotkey map reserves Mod comma for settings and Mod 1-9 for piles', () => {
  expect(settingsHotkey).toBe('Mod+,');
  expect(monadAgentHotkey).toBe('Mod+`');
  expect(sidebarNumberHotkeys).toEqual([
    'Mod+1',
    'Mod+2',
    'Mod+3',
    'Mod+4',
    'Mod+5',
    'Mod+6',
    'Mod+7',
    'Mod+8',
    'Mod+9'
  ]);
});

test('sidebar shortcuts stay on a capture listener', () => {
  expect(sidebarShortcutListenerOptions.capture).toBe(true);
});

test('settings shortcut prevents browser default without stopping propagation', () => {
  let toggled = 0;
  const shortcut = shortcutEvent({ key: ',', code: 'Comma', metaKey: true });
  const handler = createSidebarShortcutHandler({
    applePlatform: true,
    revealSidebar: () => {},
    showSettings: false,
    sidebarShortcutActions: [],
    toggleSettings: () => {
      toggled += 1;
    }
  });

  handler(shortcut.event);

  expect(toggled).toBe(1);
  expect(shortcut.prevented()).toBe(1);
  expect(shortcut.stopped()).toBe(0);
});

test('monad agent shortcut reveal the sidebar and runs the dedicated action', () => {
  const calls: string[] = [];
  const shortcut = shortcutEvent({ key: '`', code: 'Backquote', metaKey: true });
  const handler = createSidebarShortcutHandler({
    applePlatform: true,
    monadAgentShortcutAction: () => calls.push('monad'),
    revealSidebar: () => calls.push('reveal'),
    showSettings: false,
    sidebarShortcutActions: [() => calls.push('one')],
    toggleSettings: () => calls.push('settings')
  });

  handler(shortcut.event);

  expect(calls).toEqual(['reveal', 'monad']);
  expect(shortcut.prevented()).toBe(1);
  expect(shortcut.stopped()).toBe(0);
});

test('number shortcuts reveal the sidebar and run the matching action', () => {
  const calls: string[] = [];
  const shortcut = shortcutEvent({ key: '2', code: 'Digit2', metaKey: true });
  const handler = createSidebarShortcutHandler({
    applePlatform: true,
    revealSidebar: () => calls.push('reveal'),
    showSettings: false,
    sidebarShortcutActions: [() => calls.push('one'), () => calls.push('two')],
    toggleSettings: () => calls.push('settings')
  });

  handler(shortcut.event);

  expect(calls).toEqual(['reveal', 'two']);
  expect(shortcut.prevented()).toBe(1);
  expect(shortcut.stopped()).toBe(0);
});
