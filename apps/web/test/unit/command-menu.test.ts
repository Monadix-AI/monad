import type { CommandItem } from '@monad/protocol';
import type { TFn } from '../../src/components/I18nProvider.tsx';

import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  COMMAND_MENU_EDGE_PADDING,
  COMMAND_MENU_ITEM_HEIGHT,
  COMMAND_MENU_SURFACE_BACKGROUND,
  CommandMenu,
  commandMenuDetailSource,
  commandMenuPanelHeight,
  commandMenuScrollTop,
  commandMenuSnappedMaxHeight
} from '../../src/features/session/CommandMenu.tsx';
import { buildCommandMenuItems, shouldActivateSlashCommandDiscovery } from '../../src/features/session/command-menu.ts';

// The menu only translates source badges; a passthrough keeps assertions on the raw keys.
const t = ((key: string) => key) as unknown as TFn;

function command(overrides: Partial<CommandItem> & Pick<CommandItem, 'id' | 'name'>): CommandItem {
  const { id, name, ...rest } = overrides;
  return {
    id: id ?? name,
    aliases: [],
    description: '',
    name,
    source: overrides.type === 'skill' ? 'custom' : 'builtin',
    type: 'action',
    enabled: true,
    ...rest
  };
}

test('command-name phase filters by prefix on both raw and display name', () => {
  const commands = [
    command({ id: 'reset', name: 'Reset', group: 'Context' }),
    command({ id: 'model', name: 'Model', argHint: '<alias>' }),
    command({ id: 'global:review', name: 'Review', type: 'skill' })
  ];
  const items = buildCommandMenuItems('/re', commands, [], [], t);
  // Skills sort before actions (rank prefix 0 vs 1), friendly name is used for the label.
  expect(items.map(({ key, label, section, typeBadge }) => ({ key, label, section, typeBadge }))).toEqual([
    { key: 'global:review', label: 'Review', section: 'Skills', typeBadge: 'Skill' },
    { key: 'reset', label: 'Reset', section: 'Commands', typeBadge: 'Command' }
  ]);
});

test('command-name phase orders builtin actions by product group', () => {
  const commands = [
    command({ id: 'check-memory', name: 'Check Memory', group: 'Memory' }),
    command({ id: 'sessions', name: 'Sessions', group: 'Conversation' }),
    command({ id: 'reset', name: 'Reset', group: 'Context' })
  ];
  const items = buildCommandMenuItems('/', commands, [], [], t);
  expect(items.map((i) => i.key)).toEqual(['sessions', 'reset', 'check-memory']);
});

test('command-name phase returns every matching command and skill', () => {
  const commands = Array.from({ length: 10 }, (_, index) =>
    command({ id: `skill-${index}`, name: `Skill ${index}`, type: 'skill' })
  );
  const items = buildCommandMenuItems('/', commands, [], [], t);
  expect(items).toHaveLength(10);
  expect(items.map((item) => item.key)).toEqual(commands.map((item) => item.id));
});

test('inline skill phase returns every matching skill', () => {
  const commands = Array.from({ length: 10 }, (_, index) =>
    command({ id: `agent:team:skill-${index}`, name: `Skill ${index}`, type: 'skill' })
  );
  const items = buildCommandMenuItems('run /', commands, [], [], t);
  expect(items).toHaveLength(10);
  expect(items.map((item) => item.key)).toEqual(commands.map((item) => item.id));
});

test('command-name phase supports non-contiguous matches with highlighted characters', () => {
  const commands = [
    command({ id: 'check-memory', name: 'Check Memory', group: 'Memory' }),
    command({ id: 'model', name: 'Model', argHint: '<alias>' })
  ];
  const items = buildCommandMenuItems('/cm', commands, [], [], t);
  expect(items.map(({ key, label, labelMatches }) => ({ key, label, labelMatches }))).toEqual([
    { key: 'check-memory', label: 'Check Memory', labelMatches: [0, 6] }
  ]);
});

test('command-name phase replaces the active slash token instead of appending to it', () => {
  const commands = [command({ id: 'memory', name: 'Memory', group: 'Memory' })];
  const items = buildCommandMenuItems('/me', commands, [], [], t);
  expect(items.map(({ insert, replace }) => ({ insert, replace }))).toEqual([
    { insert: '/memory ', replace: { start: 0, end: 3 } }
  ]);
});

test('command menu displays command labels without the slash prefix', () => {
  const commands = [
    command({ id: 'reset', name: 'Reset', group: 'Context' }),
    command({ id: 'global:review', name: 'Review', type: 'skill' })
  ];
  const items = buildCommandMenuItems('/', commands, [], [], t);
  expect(items.map(({ insert, label }) => ({ insert, label }))).toEqual([
    { insert: '/global:review ', label: 'Review' },
    { insert: '/reset ', label: 'Reset' }
  ]);
});

test('skill command source metadata uses compact labels with source details', () => {
  const commands = [
    command({ id: 'global:review', name: 'Review', type: 'skill' }),
    command({
      id: 'atom-pack:power-pack:triage',
      name: 'Triage',
      type: 'skill',
      source: 'atom-pack',
      sourceName: 'Power Pack'
    }),
    command({ id: 'agent:researcher:scan', name: 'Scan', type: 'skill', sourceName: 'Researcher' })
  ];
  const items = buildCommandMenuItems('/', commands, [], [], t);

  expect(items.map(({ key, badge, badgeTitle }) => ({ key, badge, badgeTitle }))).toEqual([
    { key: 'global:review', badge: 'G', badgeTitle: 'Global' },
    { key: 'agent:researcher:scan', badge: 'A', badgeTitle: 'Agent: Researcher' },
    { key: 'atom-pack:power-pack:triage', badge: 'P', badgeTitle: 'Atom Pack: Power Pack' }
  ]);
});

test('command detail popover source text comes from the source detail', () => {
  expect(
    commandMenuDetailSource({ label: 'Review', insert: '/global:review ', key: 'global:review', badgeTitle: 'Global' })
  ).toBe('From: Global');
  expect(
    commandMenuDetailSource({
      label: 'Scan',
      insert: '/agent:researcher:scan ',
      key: 'agent:researcher:scan',
      badgeTitle: 'Agent: Researcher'
    })
  ).toBe('From Agent: Researcher');
  expect(
    commandMenuDetailSource({
      label: 'Triage',
      insert: '/atom-pack:power-pack:triage ',
      key: 'atom-pack:power-pack:triage',
      badgeTitle: 'Atom Pack: Power Pack'
    })
  ).toBe('From Atom Pack: Power Pack');
  expect(commandMenuDetailSource({ label: 'Reset', insert: '/reset ', key: 'reset', typeBadge: 'Command' })).toEqual(
    null
  );
});

test('skill detail popover reuses the command panel background', () => {
  const markup = renderToStaticMarkup(
    createElement(CommandMenu, {
      activeSkill: 0,
      items: [{ hint: 'Skill details', insert: '/review ', key: 'review', label: 'Review', section: 'Skills' }],
      loading: false,
      onApply: () => {},
      onHover: () => {}
    })
  );

  expect(markup.split(`background:${COMMAND_MENU_SURFACE_BACKGROUND}`).length - 1).toBe(2);
});

test('slash command discovery activates only for command entry phases', () => {
  expect(shouldActivateSlashCommandDiscovery('')).toBe(false);
  expect(shouldActivateSlashCommandDiscovery('hello')).toBe(false);
  expect(shouldActivateSlashCommandDiscovery('/')).toBe(true);
  expect(shouldActivateSlashCommandDiscovery(' /re')).toBe(true);
  expect(shouldActivateSlashCommandDiscovery('hello /')).toBe(true);
  expect(shouldActivateSlashCommandDiscovery('/reset now')).toBe(false);
  expect(shouldActivateSlashCommandDiscovery('hello /reset now')).toBe(false);
});

test('a no-arg first-party builtin executes on select; one with an argHint does not', () => {
  const commands = [
    command({ id: 'reset', name: 'Reset' }),
    command({ id: 'model', name: 'Model', argHint: '<alias>' })
  ];
  const items = buildCommandMenuItems('/', commands, [], [], t);
  const reset = items.find((i) => i.key === 'reset');
  const model = items.find((i) => i.key === 'model');
  expect(reset?.executeOnSelect).toBe(true);
  expect(model?.executeOnSelect).toBe(false);
});

test('argument phase uses structured arg metadata for dynamic suggestions', () => {
  const commands = [command({ id: 'model', name: 'Model', args: [{ name: 'alias', type: 'model' }] })];
  const profiles = [{ alias: 'smart', routes: { chat: { provider: 'openai', modelId: 'gpt-x' } } }] as never;
  const items = buildCommandMenuItems('/model sm', commands, profiles, [], t);
  expect(
    items.map(({ key, label, insert, replace, dismissAfter }) => ({ key, label, insert, replace, dismissAfter }))
  ).toEqual([
    { key: 'smart', label: 'smart', insert: '/model smart ', replace: { start: 0, end: 9 }, dismissAfter: true }
  ]);
  expect(buildCommandMenuItems(items[0]?.insert ?? '', commands, profiles, [], t)).toEqual([]);
});

test('subcommand phase suggests subcommands and then their args', () => {
  const commands = [
    command({
      id: 'memory',
      name: 'Memory',
      subcommands: [
        {
          id: 'consolidate',
          name: 'Consolidate',
          description: 'Consolidate memory layers',
          aliases: [],
          shortcut: 'consolidate',
          args: [{ name: 'level', type: 'enum', values: [{ id: '1', name: 'L1' }] }]
        }
      ]
    })
  ];
  const subcommands = buildCommandMenuItems('/memory c', commands, [], [], t);
  expect(subcommands.map(({ key, label, badge, insert, replace }) => ({ key, label, badge, insert, replace }))).toEqual(
    [
      {
        key: 'memory:consolidate',
        label: 'Consolidate',
        badge: '/consolidate',
        insert: '/memory consolidate ',
        replace: { start: 0, end: 9 }
      }
    ]
  );
  const args = buildCommandMenuItems('/memory consolidate ', commands, [], [], t);
  expect(args.map(({ key, label, insert, replace }) => ({ key, label, insert, replace }))).toEqual([
    { key: '1', label: 'L1', insert: '/memory consolidate 1 ', replace: { start: 0, end: 20 } }
  ]);
  expect(buildCommandMenuItems(args[0]?.insert ?? '', commands, [], [], t)).toEqual([]);
});

test('unavailable commands are excluded from suggestions', () => {
  const commands = [command({ id: 'reset', name: 'Reset', enabled: false })];
  expect(buildCommandMenuItems('/', commands, [], [], t)).toEqual([]);
});

test('command menu scrolls by one standard item while preserving padded edges', () => {
  expect(commandMenuScrollTop({ current: 0, itemTop: 210, itemBottom: 241, viewportHeight: 224 })).toBe(
    COMMAND_MENU_ITEM_HEIGHT
  );
  expect(commandMenuScrollTop({ current: 62, itemTop: 58, itemBottom: 89, viewportHeight: 224 })).toBe(
    62 - COMMAND_MENU_ITEM_HEIGHT
  );
  expect(commandMenuScrollTop({ current: 31, itemTop: 40, itemBottom: 71, viewportHeight: 224 })).toBe(0);
  expect(commandMenuScrollTop({ current: 62, itemTop: 80, itemBottom: 111, viewportHeight: 224 })).toBe(
    62 - COMMAND_MENU_ITEM_HEIGHT
  );
});

test('command menu height snaps to whole items plus edge padding', () => {
  expect(commandMenuPanelHeight(7)).toBe(COMMAND_MENU_EDGE_PADDING * 2 + COMMAND_MENU_ITEM_HEIGHT * 7);
  expect(commandMenuSnappedMaxHeight(224)).toBe(commandMenuPanelHeight(6));
  expect(commandMenuSnappedMaxHeight(260)).toBe(commandMenuPanelHeight(7));
});

test('sticky section header masks the complete top edge of the scrolling panel', () => {
  const markup = renderToStaticMarkup(
    createElement(CommandMenu, {
      activeSkill: 0,
      items: [{ insert: '/reset ', key: 'reset', label: 'Reset', section: 'Commands' }],
      loading: false,
      onApply: () => undefined,
      onHover: () => undefined
    })
  );

  expect(markup).toBe(
    '<div><div class="glass-surface fixed z-50 overflow-visible rounded-[10px] border text-popover-foreground" style="bottom:12px;left:12px;max-height:225px;width:288px;backdrop-filter:blur(18px) saturate(1.15);background:color-mix(in srgb, var(--popover) 84%, transparent);border-color:rgb(var(--borderColor-secondary) / 0.12);box-shadow:0 1px 0 rgb(var(--borderColor-secondary) / 0.05), 0 18px 42px -28px rgb(0 0 0 / 0.42)"><div class="relative overflow-hidden rounded-[9px]" data-command-menu-viewport="true"><div class="pointer-events-none absolute right-0 left-0 z-30 flex items-center rounded-t-[9px] bg-popover px-3 font-medium text-[10.5px] text-muted-foreground leading-none" data-command-menu-sticky-header="true" style="height:35px;padding-top:4px;top:0">Commands</div><div class="overflow-y-auto overscroll-contain rounded-[9px] p-1 [scrollbar-width:none] [&amp;::-webkit-scrollbar]:hidden" data-command-menu-scroll="true" style="max-height:225px;scrollbar-width:none"><div><div class="flex h-[31px] items-center px-2 font-medium text-[10.5px] text-muted-foreground leading-none">Commands</div><button class="flex min-h-[25px] w-full items-center gap-1.5 rounded-md px-2 py-[3px] text-left bg-accent text-accent-foreground" type="button"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" color="currentColor" class="size-4 shrink-0 text-muted-foreground" aria-hidden="true"><path d="M4.00004 17C4.00004 17 9.99999 12.5811 10 11C10 9.41884 4 5 4 5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"></path><path d="M12 19H20" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"></path></svg><span class="min-w-0 truncate font-medium font-mono text-[12.5px] leading-[18px]">Reset</span><span class="min-w-3 flex-1"></span></button></div></div></div></div></div>'
  );
});
