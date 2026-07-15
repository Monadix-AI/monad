// The built-in command definitions are authored with the SDK's defineCommand and consumed by the
// daemon's command registry (which tests the runtime wiring). Here we only pin the package's export
// surface: the expected set of first-party commands ships with valid, well-formed definitions.

import { expect, test } from 'bun:test';

import { BUILTIN_COMMANDS } from '../../src/commands/builtins.ts';

test('ships the expected first-party commands', () => {
  const names = BUILTIN_COMMANDS.map((c) => c.name).sort();
  expect(names).toEqual(
    [
      'check-memory',
      'clear',
      'compact',
      'consolidate',
      'end',
      'handoff',
      'help',
      'memory',
      'model',
      'new',
      'reset',
      'sessions',
      'switch',
      'view',
      'why',
      'workdir'
    ].sort()
  );
});

test('every command has a description and a runnable handler', () => {
  for (const c of BUILTIN_COMMANDS) {
    expect(typeof c.run).toBe('function');
  }
});

test('every first-party command has the expected product group', () => {
  const groups = Object.fromEntries(BUILTIN_COMMANDS.map((c) => [c.name, c.group]));
  expect(groups).toEqual({
    'check-memory': 'Memory',
    clear: 'Context',
    compact: 'Context',
    consolidate: 'Memory',
    end: 'Conversation',
    handoff: 'Conversation',
    help: 'Help',
    memory: 'Memory',
    model: 'Runtime',
    new: 'Conversation',
    reset: 'Context',
    sessions: 'Conversation',
    switch: 'Conversation',
    view: 'Context',
    why: 'Memory',
    workdir: 'Runtime'
  });
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

test('memory command advertises shortcut-backed subcommands', () => {
  const memory = BUILTIN_COMMANDS.find((c) => c.name === 'memory');
  expect(memory?.subcommands).toEqual([
    expect.objectContaining({ id: 'consolidate', shortcut: 'consolidate' }),
    expect.objectContaining({ id: 'why', shortcut: 'why' }),
    expect.objectContaining({ id: 'check', shortcut: 'check-memory' })
  ]);
});

test('view command switches the local observation render mode', async () => {
  const view = BUILTIN_COMMANDS.find((c) => c.name === 'view');
  const result = await view?.run(
    {
      args: 'compact',
      sessionId: 'ses_test',
      principalId: 'usr_test',
      newSession: async () => ({ sessionId: 'ses_new' }),
      listSessions: async () => [],
      switchSession: async () => null,
      resetHistory: async () => ({ clearedCount: 0 }),
      compact: async () => ({ compacted: 0 }),
      consolidate: async () => ({ level: 1, l1Scopes: 0, nodes: 0, edges: 0, laws: 0, prunedEdges: 0, lawScopes: 0 }),
      explainBelief: async () => ({ matches: [] }),
      checkMemory: async () => ({ flagged: 0 }),
      listModels: async () => [],
      setModel: async () => {},
      getWorkdir: async () => ({}),
      setWorkdir: async () => ({}),
      listCommands: async () => [],
      handoff: async () => ({ sessionId: 'ses_handoff' }),
      t: (key) => key,
      log: () => {}
    },
    'compact'
  );

  expect(result).toEqual({
    message: 'cmd.view.compact',
    effect: { type: 'observation-render-mode-changed', mode: 'compact' }
  });
});
