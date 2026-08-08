import type { CommandItem } from '@monad/protocol';
import type { TFn } from '../../src/components/I18nProvider.tsx';

import { expect, test } from 'bun:test';

import {
  COMMAND_MENU_EDGE_PADDING,
  COMMAND_MENU_ITEM_HEIGHT,
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
  expect(items.map(({ key }) => key)).toEqual(['global:review', 'reset']);
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
  expect(items.map(({ key, labelMatches }) => ({ key, labelMatches }))).toEqual([
    { key: 'check-memory', labelMatches: [0, 6] }
  ]);
});

test('command-name phase replaces the active slash token instead of appending to it', () => {
  const commands = [command({ id: 'memory', name: 'Memory', group: 'Memory' })];
  const items = buildCommandMenuItems('/me', commands, [], [], t);
  expect(items.map(({ insert, replace }) => ({ insert, replace }))).toEqual([
    { insert: '/memory ', replace: { start: 0, end: 3 } }
  ]);
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
