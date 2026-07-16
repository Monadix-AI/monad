import { expect, test } from 'bun:test';

import {
  buildCommandPaletteSections,
  commandPaletteHotkey,
  commandPaletteSearch,
  highlightedCommandPaletteParts
} from '../../src/features/shell/command-palette.ts';

test('command palette hotkey is reserved for the global launcher', () => {
  expect(commandPaletteHotkey).toBe('Mod+K');
});

test('command palette defaults to quick actions followed by recents', () => {
  const sections = buildCommandPaletteSections({
    actions: [
      { id: 'new-chat', label: 'New chat', run: () => {}, shortcut: '⌘ N' },
      { id: 'inbox', label: 'Inbox', run: () => {} }
    ],
    recents: [
      { id: 'session-1', label: 'Debug remote auth', run: () => {} },
      { id: 'session-2', label: 'Design inbox', run: () => {} }
    ]
  });

  expect(sections.map((section) => section.heading)).toEqual(['Quick actions', 'Recents']);
  expect(sections[0]?.items.map((item) => item.id)).toEqual(['new-chat', 'inbox']);
  expect(sections[0]?.items[0]?.shortcut).toBe('⌘ N');
  expect(sections[1]?.items.map((item) => item.id)).toEqual(['session-1', 'session-2']);
});

test('command palette search matches labels, keywords, and keeps section order', () => {
  const sections = buildCommandPaletteSections({
    actions: [
      { id: 'new-chat', keywords: ['create'], label: 'New chat', run: () => {} },
      { id: 'settings', label: 'Settings', run: () => {} }
    ],
    recents: [
      { id: 'session-1', label: 'Runtime topology', run: () => {} },
      { id: 'session-2', label: 'Inbox workflow', run: () => {} }
    ]
  });

  expect(commandPaletteSearch(sections, 'top').map((section) => section.items.map((item) => item.id))).toEqual([
    ['session-1']
  ]);
  expect(commandPaletteSearch(sections, 'create').map((section) => section.items.map((item) => item.id))).toEqual([
    ['new-chat']
  ]);
});

test('command palette highlight returns matched and unmatched label parts', () => {
  expect(highlightedCommandPaletteParts('Runtime topology', 'top')).toEqual([
    { match: false, text: 'Runtime ' },
    { match: true, text: 'top' },
    { match: false, text: 'ology' }
  ]);
});
