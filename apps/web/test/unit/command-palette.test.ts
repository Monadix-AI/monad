import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  buildCommandPaletteSections,
  commandPaletteHotkey,
  commandPaletteSearch,
  highlightedCommandPaletteParts
} from '../../src/features/shell/command-palette.ts';

test('command palette hotkey is reserved for the global launcher', () => {
  expect(commandPaletteHotkey).toBe('Mod+K');
});

test('workspace sidebar exposes Search below Inbox through the existing command palette', () => {
  const workspaceItemsSource = readFileSync(
    new URL('../../src/features/shell/sidebar/workspace-items.tsx', import.meta.url),
    'utf8'
  );
  const workspaceContextSource = readFileSync(
    new URL('../../src/features/shell/sidebar/workspace-sidebar-context.tsx', import.meta.url),
    'utf8'
  );
  const sidebarSource = readFileSync(new URL('../../src/features/shell/SessionSidebar.tsx', import.meta.url), 'utf8');
  const shellSource = readFileSync(
    new URL('../../src/features/shell/page-shell/ShellRouteProvider.tsx', import.meta.url),
    'utf8'
  );
  const enLocale = readFileSync(new URL('../../../../packages/i18n/src/locales/en/web.json', import.meta.url), 'utf8');
  const zhLocale = readFileSync(new URL('../../../../packages/i18n/src/locales/zh/web.json', import.meta.url), 'utf8');
  const inboxIndex = workspaceItemsSource.indexOf("label={meta.t('web.sidebar.inbox')}");
  const searchIndex = workspaceItemsSource.indexOf("label={meta.t('web.sidebar.searchSessions')}");

  expect(inboxIndex).toBeGreaterThan(-1);
  expect(searchIndex).toBeGreaterThan(inboxIndex);
  expect(workspaceItemsSource).toContain('icon={Search01Icon}');
  expect(workspaceItemsSource).toContain('onClick={actions.openSearch}');
  expect(workspaceItemsSource).toContain("shortcutValue={meta.showShortcutBadges ? 'K' : undefined}");
  expect(workspaceContextSource).toContain('openSearch: () => void;');
  expect(sidebarSource).toContain('openSearch: onOpenSearch');
  expect(shellSource).toContain('onOpenSearch: openCommandPalette');
  expect(enLocale).toContain('"web.sidebar.searchSessions": "Search"');
  expect(zhLocale).toContain('"web.sidebar.searchSessions": "搜索"');
});

test('command palette defers focus work until after shortcut dispatch and ignores repeats', () => {
  const source = readFileSync(
    new URL('../../src/features/shell/page-shell/ShellRouteProvider.tsx', import.meta.url),
    'utf8'
  );

  expect(source).toContain('if (event.repeat || pendingCommandPaletteFrame !== 0) return;');
  expect(source).toContain('pendingCommandPaletteFrame = requestAnimationFrame(() => {');
  expect(source).toContain('cancelAnimationFrame(pendingCommandPaletteFrame);');
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

test('command palette starts with an unframed search input', () => {
  const source = readFileSync(new URL('../../src/features/shell/CommandPalette.tsx', import.meta.url), 'utf8');
  const inputIndex = source.indexOf('<Command.Input');
  const listIndex = source.indexOf('<Command.List');

  expect(inputIndex).toBeGreaterThan(-1);
  expect(inputIndex).toBeLessThan(listIndex);
  expect(source).toContain('border-0 bg-transparent');
  expect(source).toContain('shadow-none');
  expect(source).not.toContain('Command menu');
  expect(source).not.toContain('shortcutModifierLabel');
  expect(source).toContain('DialogContent, DialogTitle, ShortcutChip');
  expect(source).not.toContain('function ShortcutChip');
});

test('command palette uses compact sidebar-aligned rows with clearer group spacing', () => {
  const source = readFileSync(new URL('../../src/features/shell/CommandPalette.tsx', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../../src/styles/globals.css', import.meta.url), 'utf8');

  expect(source).toContain('w-[min(560px,calc(100vw-28px))]');
  expect(source).toContain('<DialogContent');
  expect(source).toContain('className="command-palette-dialog');
  expect(source).toContain('modal');
  expect(source).toContain('overlayClassName="command-palette-overlay z-[70] bg-black/20 dark:bg-black/45"');
  expect(source).toContain('min-h-8');
  expect(source).toContain('px-2 py-1.5');
  expect(source).toContain('mt-2 first:mt-0');
  expect(source).not.toContain('w-[min(640px,calc(100vw-28px))]');
  expect(source).not.toContain('<Command.Dialog');
  expect(source).not.toContain('h-10 cursor-default');
  expect(source).toContain('data-[selected=true]:bg-sidebar-selected');
  expect(source).toContain('data-[selected=true]:hover:bg-sidebar-selected-hover');
  expect(source).not.toContain('data-[selected=true]:bg-accent');
  expect(source).not.toContain('data-[selected=true]:shadow-');
  expect(source).toContain('<ShortcutChip>{item.shortcut}</ShortcutChip>');
  expect(source).not.toContain('<ShortcutChip style={commandPaletteSurfaceStyle}>');
  expect(styles).toMatch(
    /\.command-palette-group \[cmdk-group-heading\] \{[^}]*padding: 12px 8px 7px;[^}]*color: color-mix\(in oklab, var\(--muted-foreground\) 72%, transparent\);/s
  );
});

test('command palette renders semantic icons for quick actions', () => {
  const paletteSource = readFileSync(new URL('../../src/features/shell/CommandPalette.tsx', import.meta.url), 'utf8');
  const shellSource = readFileSync(
    new URL('../../src/features/shell/page-shell/ShellRouteProvider.tsx', import.meta.url),
    'utf8'
  );

  expect(paletteSource).toContain('item.icon ?');
  expect(paletteSource).toContain('icon={item.icon}');
  expect(shellSource).toContain('icon: ChatAdd01Icon');
  expect(shellSource).toContain('icon: InboxIcon');
  expect(shellSource).toContain('icon: CpuIcon');
  expect(shellSource).toContain('icon: Settings02Icon');
  expect(shellSource).toContain('icon: FileArchiveIcon');
  expect(shellSource).toMatch(/shortcut: `\$\{shortcutModifierLabel\}N`/);
  expect(shellSource).toMatch(/shortcut: `\$\{shortcutModifierLabel\}I`/);
  expect(shellSource).toMatch(/shortcut: `\$\{shortcutModifierLabel\},`/);
});

test('command palette replaces local recents with unarchived server search results', () => {
  const paletteSource = readFileSync(new URL('../../src/features/shell/CommandPalette.tsx', import.meta.url), 'utf8');
  const shellSource = readFileSync(
    new URL('../../src/features/shell/page-shell/ShellRouteProvider.tsx', import.meta.url),
    'utf8'
  );

  expect(shellSource).toContain('useServerSessionSearch({');
  expect(shellSource).toContain('archived: false');
  expect(shellSource).toContain('limit: 20');
  expect(shellSource).toMatch(
    /commandPaletteQuery\.trim\(\)\s*\?\s*commandPaletteSearching\s*\?\s*sessions\.slice\(0, 8\)\s*:\s*commandSearchSessions\s*:\s*sessions\.slice\(0, 8\)/s
  );
  expect(paletteSource).toContain('onSearchChange: (query: string) => void');
  expect(paletteSource).not.toContain("const [search, setSearch] = useState('')");
});

test('command palette keeps local results visible without a search loading indicator', () => {
  const paletteSource = readFileSync(new URL('../../src/features/shell/CommandPalette.tsx', import.meta.url), 'utf8');
  const shellSource = readFileSync(
    new URL('../../src/features/shell/page-shell/ShellRouteProvider.tsx', import.meta.url),
    'utf8'
  );

  expect(shellSource).toMatch(/commandPaletteSearching\s*\?\s*sessions\.slice\(0, 8\)\s*:\s*commandSearchSessions/s);
  expect(paletteSource).not.toContain('searching?: boolean');
  expect(paletteSource).not.toContain("t('web.common.loading')");
});
