import { expect, test } from 'bun:test';

import {
  activateVisibleSidebarSession,
  createSidebarShortcutHandler,
  createVisibleSidebarSessionShortcutActions,
  inboxHotkey,
  newChatHotkey,
  settingsHotkey,
  sidebarNumberHotkeys,
  sidebarShortcutListenerOptions,
  syncVisibleSidebarSessionShortcutBadges,
  visibleSidebarSessionRows
} from '../../src/hooks/use-sidebar-shortcuts.ts';

function fakeRow(testId: string, inert = false) {
  let clicked = 0;
  const row = {
    click: () => {
      clicked += 1;
    },
    closest: (selector: string) => (selector === '[inert]' && inert ? {} : null),
    dataset: { testId }
  } as unknown as HTMLElement;
  return { clicked: () => clicked, row };
}

function fakeRoot(rows: HTMLElement[]) {
  return {
    querySelectorAll: () => rows
  } as unknown as Pick<Document, 'querySelectorAll'>;
}

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
    },
    stopImmediatePropagation: () => {
      stopped += 1;
    }
  } as KeyboardEvent;

  return {
    event,
    prevented: () => prevented,
    stopped: () => stopped
  };
}

const platforms = [
  {
    applePlatform: true,
    label: 'mac',
    primaryModifier: { metaKey: true },
    secondaryModifier: { ctrlKey: true }
  },
  {
    applePlatform: false,
    label: 'non-mac',
    primaryModifier: { ctrlKey: true },
    secondaryModifier: { metaKey: true }
  }
] as const;

test('sidebar hotkey map reserves global actions and Mod 1-9 navigation', () => {
  expect(settingsHotkey).toBe('Mod+,');
  expect(newChatHotkey).toBe('Mod+`');
  expect(inboxHotkey).toBe('Mod+I');
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

test('visible session shortcuts preserve DOM order and skip inert rows', () => {
  const pinned = fakeRow('pinned');
  const collapsed = fakeRow('collapsed', true);
  const project = fakeRow('project');
  const chat = fakeRow('chat');

  expect(
    visibleSidebarSessionRows(fakeRoot([pinned.row, collapsed.row, project.row, chat.row])).map(
      (row) => row.dataset.testId
    )
  ).toEqual(['pinned', 'project', 'chat']);
});

test('visible session activation clicks only an existing target', () => {
  const first = fakeRow('first');
  const collapsed = fakeRow('collapsed', true);
  const second = fakeRow('second');
  const root = fakeRoot([first.row, collapsed.row, second.row]);

  expect(activateVisibleSidebarSession(1, root)).toBe(true);
  expect(activateVisibleSidebarSession(2, root)).toBe(false);
  expect(first.clicked()).toBe(0);
  expect(collapsed.clicked()).toBe(0);
  expect(second.clicked()).toBe(1);
});

test('session shortcut badges number only the first nine visible rows and clear stale values', () => {
  const rows = Array.from({ length: 11 }, (_, index) => fakeRow(`row-${index}`, index === 1).row);
  rows[1].dataset.sidebarShortcut = '8';
  rows[10].dataset.sidebarShortcut = '9';

  syncVisibleSidebarSessionShortcutBadges('⌘', fakeRoot(rows));

  expect(rows.map((row) => row.dataset.sidebarShortcut ?? null)).toEqual([
    '1',
    null,
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    '8',
    '9',
    null
  ]);
  expect(rows.map((row) => row.dataset.sidebarShortcutModifier ?? null)).toEqual([
    '⌘',
    null,
    '⌘',
    '⌘',
    '⌘',
    '⌘',
    '⌘',
    '⌘',
    '⌘',
    '⌘',
    null
  ]);
});

test('workspace session shortcuts build nine ordered activators', () => {
  const calls: number[] = [];
  const actions = createVisibleSidebarSessionShortcutActions((index) => {
    calls.push(index);
    return true;
  });

  expect(actions).toHaveLength(9);
  actions[0]?.();
  actions[8]?.();
  expect(calls).toEqual([0, 8]);
});

test('sidebar shortcuts stay on a capture listener', () => {
  expect(sidebarShortcutListenerOptions.capture).toBe(true);
});

for (const platform of platforms) {
  test(`settings shortcut uses the primary modifier on ${platform.label}`, () => {
    let toggled = 0;
    const shortcut = shortcutEvent({ key: ',', code: 'Comma', ...platform.primaryModifier });
    const secondaryShortcut = shortcutEvent({ key: ',', code: 'Comma', ...platform.secondaryModifier });
    const handler = createSidebarShortcutHandler({
      applePlatform: platform.applePlatform,
      revealSidebar: () => {},
      showSettings: false,
      sidebarShortcutActions: [],
      toggleSettings: () => {
        toggled += 1;
      }
    });

    handler(shortcut.event);
    handler(secondaryShortcut.event);

    expect(toggled).toBe(1);
    expect(shortcut.prevented()).toBe(1);
    expect(shortcut.stopped()).toBe(2);
    expect(secondaryShortcut.prevented()).toBe(0);
  });

  test(`new chat and inbox shortcuts use the primary modifier on ${platform.label}`, () => {
    const calls: string[] = [];
    const newChatShortcut = shortcutEvent({ key: '`', code: 'Backquote', ...platform.primaryModifier });
    const inboxShortcut = shortcutEvent({ key: 'i', code: 'KeyI', ...platform.primaryModifier });
    const secondaryNewChatShortcut = shortcutEvent({ key: '`', code: 'Backquote', ...platform.secondaryModifier });
    const handler = createSidebarShortcutHandler({
      applePlatform: platform.applePlatform,
      inboxShortcutAction: () => calls.push('inbox'),
      newChatShortcutAction: () => calls.push('new-chat'),
      revealSidebar: () => calls.push('reveal'),
      showSettings: false,
      sidebarShortcutActions: [],
      toggleSettings: () => calls.push('settings')
    });

    handler(newChatShortcut.event);
    handler(inboxShortcut.event);
    handler(secondaryNewChatShortcut.event);

    expect(calls).toEqual(['reveal', 'new-chat', 'reveal', 'inbox']);
    expect(newChatShortcut.prevented()).toBe(1);
    expect(newChatShortcut.stopped()).toBe(2);
    expect(inboxShortcut.prevented()).toBe(1);
    expect(inboxShortcut.stopped()).toBe(2);
    expect(secondaryNewChatShortcut.prevented()).toBe(0);
  });

  test(`new chat shortcut matches the physical backquote key on ${platform.label}`, () => {
    const calls: string[] = [];
    const shortcut = shortcutEvent({ key: 'Dead', code: 'Backquote', ...platform.primaryModifier });
    const handler = createSidebarShortcutHandler({
      applePlatform: platform.applePlatform,
      newChatShortcutAction: () => calls.push('new-chat'),
      revealSidebar: () => calls.push('reveal'),
      showSettings: false,
      sidebarShortcutActions: [],
      toggleSettings: () => calls.push('settings')
    });

    handler(shortcut.event);

    expect(calls).toEqual(['reveal', 'new-chat']);
    expect(shortcut.prevented()).toBe(1);
    expect(shortcut.stopped()).toBe(2);
  });

  test(`number shortcuts use the primary modifier on ${platform.label}`, () => {
    const calls: string[] = [];
    const shortcut = shortcutEvent({ key: '2', code: 'Digit2', ...platform.primaryModifier });
    const secondaryShortcut = shortcutEvent({ key: '2', code: 'Digit2', ...platform.secondaryModifier });
    const handler = createSidebarShortcutHandler({
      applePlatform: platform.applePlatform,
      revealSidebar: () => calls.push('reveal'),
      showSettings: false,
      sidebarShortcutActions: [() => calls.push('one'), () => calls.push('two')],
      toggleSettings: () => calls.push('settings')
    });

    handler(shortcut.event);
    handler(secondaryShortcut.event);

    expect(calls).toEqual(['reveal', 'two']);
    expect(shortcut.prevented()).toBe(1);
    expect(shortcut.stopped()).toBe(2);
    expect(secondaryShortcut.prevented()).toBe(0);
  });
}
