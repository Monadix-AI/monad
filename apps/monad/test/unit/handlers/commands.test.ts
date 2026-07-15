import type { CommandItem, PrincipalId, SessionId } from '@monad/protocol';
import type { CommandModelInfo, CommandRunContext, CommandSessionInfo } from '@monad/sdk-atom';

import { describe, expect, test } from 'bun:test';
import { createI18n } from '@monad/i18n';
import { enMessages as i18nMessages } from '@monad/i18n/messages';
import { defineCommand } from '@monad/sdk-atom';

import { makeCommandRunContext } from '#/handlers/commands/context.ts';
import { dispatchCommand } from '#/handlers/commands/dispatch.ts';
import { CommandRegistry } from '#/handlers/commands/index.ts';
import { seededCommandRegistry } from '../../helpers.ts';

type ServicesOver = Partial<Parameters<typeof makeCommandRunContext>[0]['services']>;

const enT = createI18n({ locale: 'en', packs: [{ locale: 'en', name: 'English', messages: i18nMessages }] }).t;

function fakeCtx(args: string, servicesOver: ServicesOver = {}): CommandRunContext {
  const sessions: CommandSessionInfo[] = [
    { sessionId: 'ses_a00000000000', label: 'Alpha', active: true },
    { sessionId: 'ses_b00000000000', label: 'Beta', active: false }
  ];
  const models: CommandModelInfo[] = [
    { alias: 'fast', provider: 'p', modelId: 'm1', current: true },
    { alias: 'smart', provider: 'p', modelId: 'm2', current: false }
  ];
  return makeCommandRunContext({
    sessionId: 'ses_a00000000000' as SessionId,
    principalId: 'prn_x00000000000' as PrincipalId,
    args,
    nav: {
      newSession: async () => ({ sessionId: 'ses_new000000000' }),
      listSessions: async () => sessions,
      switchSession: async (t) => sessions[Number(t) - 1] ?? sessions.find((s) => s.sessionId === t) ?? null
    },
    services: {
      resetHistory: async () => ({ clearedCount: 3 }),
      compact: async () => ({ compacted: 1 }),
      consolidate: async () => ({ level: 1, l1Scopes: 0, nodes: 0, edges: 0, prunedEdges: 0, laws: 0, lawScopes: 0 }),
      explainBelief: async () => ({ matches: [] }),
      checkMemory: async () => ({ flagged: 0 }),
      listModels: async () => models,
      setModel: async () => {},
      getWorkdir: async () => ({ path: undefined }),
      setWorkdir: async (_sid, path) => ({ path }),
      listCommands: async () => [] as CommandItem[],
      handoff: async () => ({ sessionId: 'ses_new000000000' as SessionId }),
      t: enT,
      log: () => {},
      ...servicesOver
    }
  });
}

describe('i18n: command replies follow the active locale', () => {
  test('switching to zh localizes built-in replies (the core deliverable)', async () => {
    const { BUILTIN_LOCALES_DIR } = await import('@monad/i18n/locale-dir');
    const { loadLocalePacksFromDir, defaultLocaleName } = await import('@monad/i18n');
    const packs = await loadLocalePacksFromDir(BUILTIN_LOCALES_DIR, defaultLocaleName);
    const zhT = createI18n({ locale: 'zh', packs }).t;
    const r = seededCommandRegistry();

    const zhNew = await dispatchCommand(r, '/new', (a) => fakeCtx(a, { t: zhT }));
    expect(zhNew?.message).toBe('🆕 已开启新对话。');

    // plural via Intl.PluralRules (zh has only "other"); resetHistory mock returns clearedCount: 3
    const zhReset = await dispatchCommand(r, '/reset', (a) => fakeCtx(a, { t: zhT }));
    expect(zhReset?.message).toBe('🧹 已清除 3 条消息。');

    const zhCompact = await dispatchCommand(r, '/compact', (a) => fakeCtx(a, { t: zhT }));
    expect(zhCompact?.message).toBe('🗜️ 上下文已压缩。');

    // English still works through the same path (default locale)
    const enNew = await dispatchCommand(r, '/new', (a) => fakeCtx(a, { t: enT }));
    expect(enNew?.message).toBe('🆕 Started a new conversation.');
  });
});

describe('/workdir (shared working folder)', () => {
  test('no arg shows the current folder, or a "none" notice when unset', async () => {
    const r = seededCommandRegistry();
    const none = await dispatchCommand(r, '/workdir', (a) =>
      fakeCtx(a, { getWorkdir: async () => ({ path: undefined }) })
    );
    expect(none?.message).toBe('No working folder set — using the default workspace.');

    const shown = await dispatchCommand(r, '/workdir', (a) =>
      fakeCtx(a, { getWorkdir: async () => ({ path: '/tmp/project' }) })
    );
    expect(shown?.message).toBe('📁 Working folder: /tmp/project');
  });

  test('with a path sets the folder and emits a workdir-changed effect', async () => {
    const r = seededCommandRegistry();
    let received: string | undefined;
    const res = await dispatchCommand(r, '/workdir /tmp/project', (a) =>
      fakeCtx(a, {
        setWorkdir: async (_sid, path) => {
          received = path;
          return { path };
        }
      })
    );
    expect(received).toBe('/tmp/project');
    expect(res?.message).toBe('📁 Working folder set to /tmp/project.');
    expect(res?.effect).toEqual({ type: 'workdir-changed', path: '/tmp/project' });
  });

  test('runs for a non-owner caller', async () => {
    const r = seededCommandRegistry();
    let received: string | undefined;
    const res = await dispatchCommand(
      r,
      '/workdir /tmp/project',
      (a) =>
        fakeCtx(a, {
          setWorkdir: async (_sid, path) => {
            received = path;
            return { path };
          }
        }),
      {}
    );
    expect(received).toBe('/tmp/project');
    expect(res?.effect).toEqual({ type: 'workdir-changed', path: '/tmp/project' });
  });

  test('replies are localized (zh)', async () => {
    const { BUILTIN_LOCALES_DIR } = await import('@monad/i18n/locale-dir');
    const { loadLocalePacksFromDir, defaultLocaleName } = await import('@monad/i18n');
    const packs = await loadLocalePacksFromDir(BUILTIN_LOCALES_DIR, defaultLocaleName);
    const zhT = createI18n({ locale: 'zh', packs }).t;
    const r = seededCommandRegistry();

    const none = await dispatchCommand(r, '/workdir', (a) =>
      fakeCtx(a, { t: zhT, getWorkdir: async () => ({ path: undefined }) })
    );
    expect(none?.message).toBe('未设置工作文件夹——使用默认 workspace。');

    const set = await dispatchCommand(r, '/workdir /tmp/project', (a) =>
      fakeCtx(a, { t: zhT, setWorkdir: async (_sid, path) => ({ path }) })
    );
    expect(set?.message).toBe('📁 工作文件夹已设置为 /tmp/project。');
  });
});

describe('CommandRegistry precedence', () => {
  test('built-in names are reserved and cannot be overridden by an atom', () => {
    const warnings: string[] = [];
    const r = seededCommandRegistry((level, msg) => level === 'warn' && warnings.push(msg));
    r.registerAtom(
      'evil',
      defineCommand({ name: 'reset', description: 'hijack', run: async () => ({ message: 'pwned' }) })
    );
    const entry = r.resolve('reset');
    expect(entry?.source).toBe('builtin');
    expect(warnings.some((w) => w.includes('cannot be overridden'))).toBe(true);
  });

  test('an atom alias colliding with a built-in: the command still registers, the reserved alias stays built-in', () => {
    const r = seededCommandRegistry();
    // 'start' is an alias of the built-in /new. The command coexists under its own name + qualified
    // form; only the reserved bare alias is not taken.
    r.registerAtom('p', defineCommand({ name: 'launch', aliases: ['start'], description: 'x', run: async () => ({}) }));
    expect(r.resolve('launch')?.source).toBe('atom'); // command registered (not whole-rejected)
    expect(r.resolve('p.launch')?.source).toBe('atom'); // qualified always addressable
    expect(r.resolve('start')?.source).toBe('builtin'); // reserved alias untouched
  });

  test('a fresh atom command registers and resolves', () => {
    const r = seededCommandRegistry();
    r.registerAtom(
      'acme',
      defineCommand({ name: 'acme-x', description: 'deploy', run: async () => ({ message: 'ok' }) })
    );
    const e = r.resolve('acme-x');
    expect(e?.source).toBe('atom');
    expect(e?.atomName).toBe('acme');
  });

  test('an atom pack id must be slash-token compatible for command registration', () => {
    const warnings: string[] = [];
    const r = seededCommandRegistry((level, msg) => level === 'warn' && warnings.push(msg));
    r.registerAtom('bad_pack', defineCommand({ name: 'deploy', description: 'x', run: async () => ({}) }));
    expect(r.resolve('bad_pack.deploy')).toBeUndefined();
    expect(warnings.join('\n')).toContain('must be lowercase-with-hyphens');
  });

  test('malformed structured args from an atom command are rejected', () => {
    const warnings: string[] = [];
    const r = seededCommandRegistry((level, msg) => level === 'warn' && warnings.push(msg));
    r.registerAtom('acme', {
      name: 'deploy',
      description: 'x',
      args: [{ name: 'target', type: 'enum', required: 'yes', values: [{ id: 'prod', name: 1 }] }],
      run: async () => ({})
    });
    expect(r.resolve('deploy')).toBeUndefined();
    expect(warnings.join('\n')).toContain('malformed command');
  });

  test('atom-vs-atom collision: both coexist (qualified), bare = first-wins; pin can override', () => {
    const r = new CommandRegistry();
    r.registerAtom('a', defineCommand({ name: 'dup', description: 'first', run: async () => ({ message: '1' }) }));
    r.registerAtom('b', defineCommand({ name: 'dup', description: 'second', run: async () => ({ message: '2' }) }));
    expect(r.resolve('dup')?.atomName).toBe('a'); // bare first-wins
    expect(r.resolve('a.dup')?.atomName).toBe('a'); // both qualified forms addressable
    expect(r.resolve('b.dup')?.atomName).toBe('b');
    r.resolvePins({ dup: 'b' }); // user pins 'dup' to pack b
    expect(r.resolve('dup')?.atomName).toBe('b');
  });

  test('list() returns enabled command items for built-ins, atom commands, and user-invocable skills', () => {
    const r = seededCommandRegistry();
    r.registerAtom('acme', defineCommand({ name: 'acme-x', description: 'd', run: async () => ({}) }));
    const specs = r.list([
      { name: 'global:deep-research', description: 'research', userInvocable: true, available: true },
      { name: 'internal', description: 'hidden', userInvocable: false, available: true }
    ]);
    expect(specs.find((s) => s.id === 'reset')).toMatchObject({
      id: 'reset',
      name: 'Reset',
      type: 'action',
      source: 'builtin',
      group: 'Context',
      enabled: true
    });
    expect(specs.find((s) => s.id === 'acme.acme-x')).toMatchObject({
      id: 'acme.acme-x',
      name: 'Acme X',
      type: 'action',
      source: 'atom-pack',
      sourceName: 'acme',
      aliases: ['acme.acme-x', 'acme-x'],
      enabled: true
    });
    expect(specs.find((s) => s.id === 'global:deep-research')).toMatchObject({
      id: 'global:deep-research',
      name: 'Deep Research',
      type: 'skill',
      source: 'custom',
      enabled: true
    });
  });

  test('list() supports all and disabled filters', () => {
    const r = seededCommandRegistry();
    const skills = [
      { name: 'enabled-skill', description: 'on', userInvocable: true, available: true },
      { name: 'disabled-skill', description: 'off', userInvocable: true, available: false }
    ];
    expect(r.list(skills, undefined, { filter: 'all' }).map((s) => s.id)).toEqual(
      expect.arrayContaining(['enabled-skill', 'disabled-skill'])
    );
    expect(r.list(skills, undefined, { filter: 'disabled' }).map((s) => s.id)).toEqual(['disabled-skill']);
  });

  test('list() carries structured args and subcommands from command definitions', () => {
    const r = new CommandRegistry();
    r.registerBuiltin(
      defineCommand({
        name: 'memory',
        description: 'manage memory',
        group: 'Memory',
        args: [{ name: 'query', type: 'string', required: false, placeholder: '[query]' }],
        subcommands: [
          {
            id: 'consolidate',
            name: 'Consolidate',
            description: 'Consolidate memory layers',
            shortcut: 'consolidate',
            args: [{ name: 'level', type: 'number', required: false, placeholder: '[level]' }]
          }
        ],
        run: async () => ({})
      })
    );
    expect(r.list().find((s) => s.id === 'memory')).toMatchObject({
      group: 'Memory',
      args: [{ name: 'query', type: 'string' }],
      subcommands: [
        { id: 'consolidate', name: 'Consolidate', shortcut: 'consolidate', args: [{ name: 'level', type: 'number' }] }
      ]
    });
  });
});

describe('dispatchCommand', () => {
  test('returns null for non-commands and unknown names (fall through to the loop)', async () => {
    const r = seededCommandRegistry();
    expect(await dispatchCommand(r, 'hello world', (a) => fakeCtx(a))).toBeNull();
    expect(await dispatchCommand(r, '/nope', (a) => fakeCtx(a))).toBeNull();
  });

  test('/new creates a session and emits a session-created effect', async () => {
    const r = seededCommandRegistry();
    const res = await dispatchCommand(r, '/new my label', (a) => fakeCtx(a));
    expect(res?.effect).toEqual({ type: 'session-created', sessionId: 'ses_new000000000' });
  });

  test('/reset clears history with the cleared count', async () => {
    const r = seededCommandRegistry();
    const res = await dispatchCommand(r, '/reset', (a) => fakeCtx(a));
    expect(res?.effect).toEqual({ type: 'history-reset' });
  });

  test('/compact reports when the recent tail leaves nothing to compact', async () => {
    const r = seededCommandRegistry();
    const res = await dispatchCommand(r, '/compact', (a) => fakeCtx(a, { compact: async () => ({ compacted: 0 }) }));
    expect(res?.message).toBe('Nothing to compact yet — the recent context is already kept verbatim.');
    expect(res?.effect).toEqual({ type: 'compacted', compacted: 0 });
  });

  test('/switch by index resolves and emits session-switched', async () => {
    const r = seededCommandRegistry();
    const res = await dispatchCommand(r, '/switch 2', (a) => fakeCtx(a));
    expect(res?.effect).toEqual({ type: 'session-switched', sessionId: 'ses_b00000000000' });
  });

  test('/model with no args lists profiles; with an alias switches', async () => {
    const r = seededCommandRegistry();
    const list = await dispatchCommand(r, '/model', (a) => fakeCtx(a));
    expect(list?.message).toContain('fast');
    const set = await dispatchCommand(r, '/model smart', (a) => fakeCtx(a));
    expect(set?.effect).toEqual({ type: 'model-changed', alias: 'smart' });
  });

  test('/model rejects an unknown alias without calling setModel', async () => {
    const r = seededCommandRegistry();
    const res = await dispatchCommand(r, '/model nonexistent', (a) => fakeCtx(a));
    expect(res?.message).toContain('Unknown model profile');
  });

  test('/memory routes built-in subcommands while shortcuts stay available', async () => {
    const r = seededCommandRegistry();
    const calls: string[] = [];
    const consolidate = await dispatchCommand(r, '/memory consolidate 2', (a) =>
      fakeCtx(a, {
        consolidate: async (level) => {
          calls.push(`consolidate:${level}`);
          return { level: level ?? 1, l1Scopes: 1, nodes: 2, edges: 3, prunedEdges: 0, laws: 4, lawScopes: 0 };
        }
      })
    );
    expect(calls).toEqual(['consolidate:2']);
    expect(consolidate?.message).toContain('Consolidated to L2');

    const shortcut = await dispatchCommand(r, '/consolidate 3', (a) =>
      fakeCtx(a, {
        consolidate: async (level) => {
          calls.push(`shortcut:${level}`);
          return { level: level ?? 1, l1Scopes: 0, nodes: 0, edges: 0, prunedEdges: 0, laws: 0, lawScopes: 0 };
        }
      })
    );
    expect(calls.at(-1)).toBe('shortcut:3');
    expect(shortcut?.message).toContain('Consolidated to L3');
  });

  test('an alias resolves to the canonical built-in (/ls → sessions)', async () => {
    const r = seededCommandRegistry();
    const res = await dispatchCommand(r, '/ls', (a) => fakeCtx(a));
    expect(res?.message).toContain('Alpha');
  });

  test('/help reports built-ins, atom commands, and skills', async () => {
    const r = seededCommandRegistry();
    r.registerAtom('acme', defineCommand({ name: 'acme-x', description: 'deploy', run: async () => ({}) }));
    const res = await dispatchCommand(r, '/help', (a) =>
      fakeCtx(a, {
        listCommands: async () =>
          r.list([{ name: 'deep-research', description: 'r', userInvocable: true, available: true }])
      })
    );
    expect(res?.effect?.type).toBe('help');
  });
});

describe('command dispatch', () => {
  function commandRegistry() {
    const r = seededCommandRegistry();
    r.registerAtom(
      'acme',
      defineCommand({
        name: 'acme-deploy',
        description: 'd',
        run: async () => ({ message: 'deployed' })
      })
    );
    return r;
  }

  test('runs atom commands without caller-owner gating', async () => {
    const r = commandRegistry();
    const res = await dispatchCommand(r, '/acme-deploy', (a) => fakeCtx(a));
    expect(res?.message).toBe('deployed');
  });
});

describe('concurrency guard (busy)', () => {
  test('a command is refused while a turn is streaming', async () => {
    const r = seededCommandRegistry();
    const res = await dispatchCommand(r, '/reset', (a) => fakeCtx(a), { isBusy: true });
    expect(res?.message).toContain('in progress');
  });

  test('a duringTurn command bypasses the busy guard', async () => {
    const r = seededCommandRegistry();
    r.registerAtom(
      'acme',
      defineCommand({ name: 'acme-status', description: 'd', duringTurn: true, run: async () => ({ message: 'ok' }) })
    );
    const res = await dispatchCommand(r, '/acme-status', (a) => fakeCtx(a), { isBusy: true });
    expect(res?.message).toBe('ok');
  });

  test('commands run normally when not busy', async () => {
    const r = seededCommandRegistry();
    const res = await dispatchCommand(r, '/reset', (a) => fakeCtx(a), { isBusy: false });
    expect(res?.effect).toEqual({ type: 'history-reset' });
  });
});
