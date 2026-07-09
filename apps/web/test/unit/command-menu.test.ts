import type { CommandItem } from '@monad/protocol';
import type { TFn } from '../../src/components/I18nProvider.tsx';

import { expect, test } from 'bun:test';

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
  expect(items.map((i) => i.key)).toEqual(['global:review', 'reset']);
  // Skills sort before actions (rank prefix 0 vs 1), friendly name is used for the label.
  expect(items[0]).toMatchObject({ key: 'global:review', label: '/Review', section: 'Skills', typeBadge: 'Skill' });
  expect(items[1]).toMatchObject({ key: 'reset', section: 'Commands', typeBadge: 'Command' });
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
  expect(items).toEqual([
    expect.objectContaining({
      key: 'smart',
      label: 'smart',
      insert: '/model smart',
      dismissAfter: true
    })
  ]);
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
  expect(subcommands).toEqual([
    expect.objectContaining({
      key: 'memory:consolidate',
      label: 'Consolidate',
      badge: '/consolidate',
      insert: '/memory consolidate '
    })
  ]);
  const args = buildCommandMenuItems('/memory consolidate ', commands, [], [], t);
  expect(args).toEqual([
    expect.objectContaining({
      key: '1',
      label: 'L1',
      insert: '/memory consolidate 1'
    })
  ]);
});

test('unavailable commands are excluded from suggestions', () => {
  const commands = [command({ id: 'reset', name: 'Reset', enabled: false })];
  expect(buildCommandMenuItems('/', commands, [], [], t)).toEqual([]);
});
