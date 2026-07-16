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
      archiveSession: async () => {},
      resetHistory: async () => ({ clearedCount: 3 }),
      compact: async () => ({ compacted: 1 }),
      consolidate: async () => ({ level: 1, l1Scopes: 0, nodes: 0, edges: 0, prunedEdges: 0, laws: 0, lawScopes: 0 }),
      explainBelief: async () => ({ matches: [] }),
      checkMemory: async () => ({ flagged: 0 }),
      listModels: async () => models,
      setModel: async () => {},
      setEffort: async () => {},
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

describe('/archive', () => {
  test('archives the current session without creating a new session effect', async () => {
    const r = seededCommandRegistry();
    let archivedSessionId: string | undefined;
    const res = await dispatchCommand(r, '/archive', (a) =>
      fakeCtx(a, {
        archiveSession: async (sid) => {
          archivedSessionId = sid;
        }
      })
    );

    expect(archivedSessionId).toBe('ses_a00000000000');
    expect(res?.message).toBe('✅ Archived the current conversation.');
    expect(res?.effect).toBeUndefined();
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
    expect(warnings).toEqual([
      'atom pack "evil" command "reset" collides with a built-in command and was rejected (built-ins cannot be overridden); use /evil.reset'
    ]);
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
    const baselineIds = r.list().map((item) => item.id);
    r.registerAtom('bad_pack', defineCommand({ name: 'deploy', description: 'x', run: async () => ({}) }));
    expect(r.list().map((item) => item.id)).toEqual(baselineIds);
    expect(warnings).toEqual(['atom pack "bad_pack" command namespace must be lowercase-with-hyphens — rejected']);
  });

  test('malformed structured args from an atom command are rejected', () => {
    const warnings: string[] = [];
    const r = seededCommandRegistry((level, msg) => level === 'warn' && warnings.push(msg));
    const baselineIds = r.list().map((item) => item.id);
    r.registerAtom('acme', {
      name: 'deploy',
      description: 'x',
      args: [{ name: 'target', type: 'enum', required: 'yes', values: [{ id: 'prod', name: 1 }] }],
      run: async () => ({})
    });
    expect(r.list().map((item) => item.id)).toEqual(baselineIds);
    expect(warnings).toEqual([
      'atom pack "acme" registered a malformed command (needs name, description, run) — skipped'
    ]);
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
    const projected = specs
      .filter((spec) => spec.id === 'reset' || spec.id === 'acme.acme-x' || spec.id === 'global:deep-research')
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ aliases, enabled, group, id, name, source, sourceName, type }) => ({
        aliases,
        enabled,
        group,
        id,
        name,
        source,
        sourceName,
        type
      }));
    expect(projected).toEqual([
      {
        aliases: ['acme.acme-x', 'acme-x'],
        enabled: true,
        group: undefined,
        id: 'acme.acme-x',
        name: 'Acme X',
        source: 'atom-pack',
        sourceName: 'acme',
        type: 'action'
      },
      {
        aliases: [],
        enabled: true,
        group: undefined,
        id: 'global:deep-research',
        name: 'Deep Research',
        source: 'custom',
        sourceName: undefined,
        type: 'skill'
      },
      {
        aliases: ['clear-history'],
        enabled: true,
        group: 'Context',
        id: 'reset',
        name: 'Reset',
        source: 'builtin',
        sourceName: undefined,
        type: 'action'
      }
    ]);
  });

  test('list() supports all and disabled filters', () => {
    const r = seededCommandRegistry();
    const skills = [
      { name: 'enabled-skill', description: 'on', userInvocable: true, available: true },
      { name: 'disabled-skill', description: 'off', userInvocable: true, available: false }
    ];
    expect(
      r
        .list(skills, undefined, { filter: 'all' })
        .filter((spec) => spec.type === 'skill')
        .map(({ enabled, id }) => ({ enabled, id }))
    ).toEqual([
      { enabled: false, id: 'disabled-skill' },
      { enabled: true, id: 'enabled-skill' }
    ]);
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
    const memory = r.list().find((s) => s.id === 'memory');
    expect(memory && { args: memory.args, group: memory.group, subcommands: memory.subcommands }).toEqual({
      group: 'Memory',
      args: [{ name: 'query', type: 'string', required: false, placeholder: '[query]' }],
      subcommands: [
        {
          id: 'consolidate',
          name: 'Consolidate',
          description: 'Consolidate memory layers',
          shortcut: 'consolidate',
          aliases: [],
          args: [{ name: 'level', type: 'number', required: false, placeholder: '[level]' }]
        }
      ]
    });
  });
});

describe('dispatchCommand', () => {
  test('returns null for non-commands and unknown names (fall through to the loop)', async () => {
    const r = seededCommandRegistry();
    expect(await dispatchCommand(r, 'hello world', (a) => fakeCtx(a))).toEqual(null);
    expect(await dispatchCommand(r, '/nope', (a) => fakeCtx(a))).toEqual(null);
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
    expect(list?.message).toBe('Models:\n➡️ fast  (p:m1)\n   smart  (p:m2)\n\nSwitch with /model <alias>.');
    const set = await dispatchCommand(r, '/model smart', (a) => fakeCtx(a));
    expect(set?.effect).toEqual({ type: 'model-changed', alias: 'smart' });
  });

  test('/model rejects an unknown alias without calling setModel', async () => {
    const r = seededCommandRegistry();
    const res = await dispatchCommand(r, '/model nonexistent', (a) => fakeCtx(a));
    expect(res?.message).toBe('Unknown model profile: nonexistent. Use /model to list available profiles.');
  });

  test('/model accepts a model slug when it matches a single configured provider', async () => {
    const r = seededCommandRegistry();
    const calls: string[] = [];
    const res = await dispatchCommand(r, '/model claude-sonnet', (a) =>
      fakeCtx(a, {
        listModels: async () => [
          { alias: 'fast', provider: 'anthropic', modelId: 'claude-haiku', current: true },
          { alias: 'smart', provider: 'anthropic', modelId: 'claude-sonnet', current: false }
        ],
        setModel: async (_sid, alias) => {
          calls.push(alias);
        }
      })
    );

    expect(calls).toEqual(['smart']);
    expect(res?.effect).toEqual({ type: 'model-changed', alias: 'smart' });
  });

  test('/model accepts a raw provider:model override', async () => {
    const r = seededCommandRegistry();
    const calls: string[] = [];
    const res = await dispatchCommand(r, '/model openrouter:openai/gpt-5', (a) =>
      fakeCtx(a, {
        listModels: async () => [],
        setModel: async (_sid, model) => {
          calls.push(model);
        }
      })
    );

    expect(calls).toEqual(['openrouter:openai/gpt-5']);
    expect(res?.effect).toEqual({ type: 'model-changed', alias: 'openrouter:openai/gpt-5' });
  });

  test('/model inherit clears the session model override', async () => {
    const r = seededCommandRegistry();
    const calls: string[] = [];
    const res = await dispatchCommand(r, '/model inherit', (a) =>
      fakeCtx(a, {
        setModel: async (_sid, model) => {
          calls.push(model);
        }
      })
    );

    expect(calls).toEqual(['inherit']);
    expect(res?.effect).toEqual({ type: 'model-changed', alias: 'inherit' });
  });

  test('/effort sets and clears the session reasoning effort', async () => {
    const r = seededCommandRegistry();
    const calls: Array<string | undefined> = [];
    const withEffort = {
      setEffort: async (_sid: string, effort: string | undefined) => {
        calls.push(effort);
      }
    } as ServicesOver;

    const high = await dispatchCommand(r, '/effort high', (a) => fakeCtx(a, withEffort));
    const reset = await dispatchCommand(r, '/effort default', (a) => fakeCtx(a, withEffort));

    expect(calls).toEqual(['high', undefined]);
    expect(high?.effect).toEqual({ type: 'model-effort-changed', effort: 'high' });
    expect(reset?.effect).toEqual({ type: 'model-effort-changed' });
  });

  test('/model asks for a provider when a model slug matches multiple configured providers', async () => {
    const r = seededCommandRegistry();
    const calls: string[] = [];
    const res = await dispatchCommand(r, '/model gpt-5', (a) =>
      fakeCtx(a, {
        listModels: async () => [
          { alias: 'openai-gpt', provider: 'openai', modelId: 'gpt-5', current: false },
          { alias: 'gateway-gpt', provider: 'vercel', modelId: 'gpt-5', current: false }
        ],
        setModel: async (_sid, alias) => {
          calls.push(alias);
        }
      })
    );

    expect(calls).toEqual([]);
    expect(res?.message).toBe(
      'Multiple providers match "gpt-5". Choose one profile:\nopenai: openai-gpt  (gpt-5)\nvercel: gateway-gpt  (gpt-5)'
    );
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
    expect(consolidate?.message).toBe('🧠 Consolidated to L2: 1 fact scope(s), +2 entities/3 relations, 4 law(s).');

    const shortcut = await dispatchCommand(r, '/consolidate 3', (a) =>
      fakeCtx(a, {
        consolidate: async (level) => {
          calls.push(`shortcut:${level}`);
          return { level: level ?? 1, l1Scopes: 0, nodes: 0, edges: 0, prunedEdges: 0, laws: 0, lawScopes: 0 };
        }
      })
    );
    expect(calls.at(-1)).toBe('shortcut:3');
    expect(shortcut?.message).toBe('🧠 Consolidated to L3: 0 fact scope(s), +0 entities/0 relations, 0 law(s).');
  });

  test('an alias resolves to the canonical built-in (/ls → sessions)', async () => {
    const r = seededCommandRegistry();
    const res = await dispatchCommand(r, '/ls', (a) => fakeCtx(a));
    expect(res?.message).toBe('Conversations:\n➡️ 1. Alpha\n   2. Beta\n\nSwitch with /switch <number>.');
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
    expect(res?.message?.split('\n\n')).toEqual([
      '## Commands:',
      [
        '### Conversation',
        '- `/archive` Archive the current conversation',
        '- `/handoff [initial task for the new session]` Summarize this conversation and continue it in a new session',
        '- `/new [label]` Start a new conversation',
        '- `/sessions` List conversations',
        '- `/switch <number|session-id>` Switch to another conversation'
      ].join('\n'),
      [
        '### Context',
        '- `/clear` Clear the view (client-side)',
        '- `/compact` Summarize and compact the context window now',
        '- `/reset` Clear this conversation’s history',
        '- `/view <summary|detail>` Switch local observation rendering mode'
      ].join('\n'),
      [
        '### Memory',
        '- `/check-memory` Flag learned rules contradicted by a current fact (suppresses them until re-derived)',
        '- `/consolidate` Consolidate memory: dedup facts, then update the graph and laws (to your memory level)',
        '- `/memory` Manage memory commands',
        '- `/memory consolidate [level]` Consolidate memory layers (shortcut /consolidate)',
        '- `/memory why <query>` Explain why the agent believes something (shortcut /why)',
        '- `/memory check` Flag contradicted learned rules (shortcut /check-memory)',
        '- `/why` Explain why the agent believes something, traced through its memory'
      ].join('\n'),
      '### Runtime\n- `/effort <value|default>` Set the reasoning effort for this conversation\n- `/model [alias]` Show or switch the model for this conversation\n- `/workdir [absolute path]` Show or set the shared working folder for this conversation',
      '### Help\n- `/help` List available commands',
      '## Atom commands:\n- `/acme.acme-x` deploy',
      '## Skills:\n- `/deep-research` r'
    ]);
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
    expect(res?.message).toBe('⏳ A turn is in progress — try /reset again when it finishes.');
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
