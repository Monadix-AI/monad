// The built-in command definitions are authored with the SDK's defineCommand and consumed by the
// daemon's command registry (which tests the runtime wiring). Here we only pin the package's export
// surface: the expected set of first-party commands ships with valid, well-formed definitions.

import { expect, test } from 'bun:test';

import { BUILTIN_COMMANDS } from '../../src/commands/builtins.ts';

test('ships the expected first-party commands', () => {
  const names = BUILTIN_COMMANDS.map((c) => c.name).sort();
  expect(names).toEqual(
    [
      'clear',
      'compact',
      'consolidate-graph',
      'consolidate-memory',
      'end',
      'handoff',
      'help',
      'model',
      'new',
      'reset',
      'sessions',
      'switch',
      'workdir'
    ].sort()
  );
});

test('every command has a description and a runnable handler', () => {
  for (const c of BUILTIN_COMMANDS) {
    expect(c.name).toBeTruthy();
    expect(c.description).toBeTruthy();
    expect(typeof c.run).toBe('function');
  }
});

test('command names and aliases are unique across the set', () => {
  const seen = new Set<string>();
  for (const c of BUILTIN_COMMANDS) {
    for (const key of [c.name, ...(c.aliases ?? [])]) {
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  }
});
