// The built-in command definitions are authored with the SDK's defineCommand and consumed by the
// daemon's command registry (which tests the runtime wiring). Here we only pin the package's export
// surface: the expected set of first-party commands ships with valid, well-formed definitions.

import type { CommandRunContext } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';

import { BUILTIN_COMMANDS } from '../../src/commands/builtins.ts';

test('ships the expected first-party commands', () => {
  const names = BUILTIN_COMMANDS.map((c) => c.name).sort();
  expect(names).toEqual(
    [
      'check-memory',
      'archive',
      'clear',
      'compact',
      'consolidate',
      'effort',
      'handoff',
      'help',
      'memory',
      'model',
      'new',
      'project',
      'reset',
      'sessions',
      'switch',
      'view',
      'why',
      'workdir'
    ].sort()
  );
});

test('every first-party command has the expected product group', () => {
  const groups = Object.fromEntries(BUILTIN_COMMANDS.map((c) => [c.name, c.group]));
  expect(groups).toEqual({
    'check-memory': 'Memory',
    archive: 'Conversation',
    clear: 'Context',
    compact: 'Context',
    consolidate: 'Memory',
    effort: 'Runtime',
    handoff: 'Conversation',
    help: 'Help',
    memory: 'Memory',
    model: 'Runtime',
    new: 'Conversation',
    project: 'Conversation',
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

test('model command localizes ambiguous bare model responses', async () => {
  const model = BUILTIN_COMMANDS.find((c) => c.name === 'model');
  if (!model) throw new Error('model command is not registered');

  const translations: Array<{ key: string; params?: Record<string, unknown> }> = [];
  const context = {
    args: 'shared-model',
    listModels: async () => [
      { alias: 'alpha', current: false, modelId: 'shared-model', provider: 'provider-a' },
      { alias: 'beta', current: false, modelId: 'shared-model', provider: 'provider-b' }
    ],
    t: (key: string, params?: Record<string, unknown>) => {
      translations.push({ key, params });
      return `translated:${key}`;
    }
  } as unknown as CommandRunContext;
  const result = await model.run(context, context.args);

  expect(translations).toEqual([
    {
      key: 'cmd.model.ambiguous',
      params: {
        alias: 'shared-model',
        list: 'provider-a: alpha  (shared-model)\nprovider-b: beta  (shared-model)'
      }
    }
  ]);
  expect(result).toEqual({ message: 'translated:cmd.model.ambiguous' });
});

test('project command lists the selected Project sessions and preserves an optional session effect', async () => {
  const project = BUILTIN_COMMANDS.find((command) => command.name === 'project');
  if (!project) throw new Error('project command is not registered');
  const targets: string[] = [];
  const context = {
    args: 'use 2',
    project: {
      listProjects: async () => [],
      currentProject: async () => null,
      switchProject: async (target: string) => {
        targets.push(target);
        return {
          projectId: 'prj_PROJECT000001',
          title: 'Launch',
          current: true,
          sessions: [{ sessionId: 'ses_PROJECT000001', label: 'Launch plan', active: false }],
          sessionId: 'ses_PROJECT000001'
        };
      },
      leaveProject: async () => ({ sessionId: 'ses_DEFAULT000001' })
    },
    t: (key: string, params?: Record<string, unknown>) => `${key}:${String(params?.title ?? '')}`
  } as unknown as CommandRunContext;

  const result = await project.run(context, context.args);

  expect(targets).toEqual(['2']);
  expect(result).toEqual({
    message: 'cmd.project.use.sessions:Launch',
    effect: { type: 'session-switched', sessionId: 'ses_PROJECT000001' }
  });
});

test('view command switches the local observation render mode', async () => {
  const view = BUILTIN_COMMANDS.find((c) => c.name === 'view');
  const result = await view?.run(
    {
      args: 'summary',
      sessionId: 'ses_test',
      newSession: async () => ({ sessionId: 'ses_new' }),
      listSessions: async () => [],
      switchSession: async () => null,
      archiveSession: async () => {},
      resetHistory: async () => ({ clearedCount: 0 }),
      compact: async () => ({ compacted: 0 }),
      consolidate: async () => ({ level: 1, l1Scopes: 0, nodes: 0, edges: 0, laws: 0, prunedEdges: 0, lawScopes: 0 }),
      explainBelief: async () => ({ matches: [] }),
      checkMemory: async () => ({ flagged: 0 }),
      listModels: async () => [],
      setModel: async () => {},
      setEffort: async () => {},
      getWorkdir: async () => ({}),
      setWorkdir: async () => ({}),
      listCommands: async () => [],
      handoff: async () => ({ sessionId: 'ses_handoff' }),
      t: (key) => key,
      log: () => {}
    },
    'summary'
  );

  expect(result).toEqual({
    message: 'cmd.view.summary',
    effect: { type: 'observation-render-mode-changed', mode: 'summary' }
  });
});
