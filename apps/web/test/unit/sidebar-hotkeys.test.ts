import { expect, test } from 'bun:test';

import {
  activateVisibleSidebarSession,
  createSidebarShortcutHandler,
  createVisibleSidebarSessionShortcutActions,
  inboxHotkey,
  monadAgentHotkey,
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
    }
  } as KeyboardEvent;

  return {
    event,
    prevented: () => prevented,
    stopped: () => stopped
  };
}

test('sidebar hotkey map reserves global actions and Mod 1-9 navigation', () => {
  expect(settingsHotkey).toBe('Mod+,');
  expect(monadAgentHotkey).toBe('Mod+`');
  expect(newChatHotkey).toBe('Mod+N');
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

  expect(rows[0].dataset.sidebarShortcut).toBe('1');
  expect(rows[0].dataset.sidebarShortcutModifier).toBe('⌘');
  expect(rows[1].dataset.sidebarShortcut).toBeUndefined();
  expect(rows[9].dataset.sidebarShortcut).toBe('9');
  expect(rows[10].dataset.sidebarShortcut).toBeUndefined();
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

test('new chat and inbox shortcuts reveal the sidebar and run dedicated actions', () => {
  const calls: string[] = [];
  const newChatShortcut = shortcutEvent({ key: 'n', code: 'KeyN', metaKey: true });
  const inboxShortcut = shortcutEvent({ key: 'i', code: 'KeyI', metaKey: true });
  const handler = createSidebarShortcutHandler({
    applePlatform: true,
    inboxShortcutAction: () => calls.push('inbox'),
    newChatShortcutAction: () => calls.push('new-chat'),
    revealSidebar: () => calls.push('reveal'),
    showSettings: false,
    sidebarShortcutActions: [],
    toggleSettings: () => calls.push('settings')
  });

  handler(newChatShortcut.event);
  handler(inboxShortcut.event);

  expect(calls).toEqual(['reveal', 'new-chat', 'reveal', 'inbox']);
  expect(newChatShortcut.prevented()).toBe(1);
  expect(inboxShortcut.prevented()).toBe(1);
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
