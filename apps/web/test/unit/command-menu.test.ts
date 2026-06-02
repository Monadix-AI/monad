import type { CommandSpec } from '@monad/protocol';
import type { TFn } from '../../components/I18nProvider.tsx';

import { expect, test } from 'bun:test';

import {
  buildCommandMenuItems,
  skillCommandDisplayName,
  skillCommandSource
} from '../../components/routes/sessions/command-menu.ts';

// The menu only translates source badges; a passthrough keeps assertions on the raw keys.
const t = ((key: string) => key) as unknown as TFn;

function command(overrides: Partial<CommandSpec> & Pick<CommandSpec, 'name' | 'kind'>): CommandSpec {
  return {
    aliases: [],
    description: '',
    source: overrides.kind === 'prompt' ? 'skill' : 'builtin',
    available: true,
    ...overrides
  };
}

test('skillCommandDisplayName strips the source qualifier', () => {
  expect(skillCommandDisplayName('global:foo')).toBe('foo');
  expect(skillCommandDisplayName('atom-pack:pack:bar')).toBe('bar');
  expect(skillCommandDisplayName('agent:helper:baz')).toBe('baz');
  expect(skillCommandDisplayName('plain')).toBe('plain');
});

test('skillCommandSource classifies the qualifier', () => {
  expect(skillCommandSource('global:foo')).toEqual({ kind: 'global' });
  expect(skillCommandSource('atom-pack:pack:bar')).toEqual({ kind: 'atom-pack', name: 'pack' });
  expect(skillCommandSource('agent:helper:baz')).toEqual({ kind: 'agent', name: 'helper' });
  expect(skillCommandSource('plain')).toBeNull();
});

test('command-name phase filters by prefix on both raw and display name', () => {
  const commands = [
    command({ name: 'reset', kind: 'builtin' }),
    command({ name: 'model', kind: 'builtin', argHint: '<alias>' }),
    command({ name: 'global:review', kind: 'prompt' })
  ];
  const items = buildCommandMenuItems('/re', commands, [], [], t);
  expect(items.map((i) => i.key)).toEqual(['global:review', 'reset']);
  // Skills sort before builtins (rank prefix 0 vs 1), display name used for the label.
  expect(items[0]).toMatchObject({ key: 'global:review', label: '/review', typeBadge: 'Skill' });
});

test('a no-arg first-party builtin executes on select; one with an argHint does not', () => {
  const commands = [
    command({ name: 'reset', kind: 'builtin' }),
    command({ name: 'model', kind: 'builtin', argHint: '<alias>' })
  ];
  const items = buildCommandMenuItems('/', commands, [], [], t);
  const reset = items.find((i) => i.key === 'reset');
  const model = items.find((i) => i.key === 'model');
  expect(reset?.executeOnSelect).toBe(true);
  expect(model?.executeOnSelect).toBe(false);
});

test('unavailable commands are excluded from suggestions', () => {
  const commands = [command({ name: 'reset', kind: 'builtin', available: false })];
  expect(buildCommandMenuItems('/re', commands, [], [], t)).toEqual([]);
});
