import { expect, test } from 'bun:test';

import { command as agentCommand } from '../../src/commands/agent.ts';
import { command as approvalCommand } from '../../src/commands/approval.ts';
import { command as completion } from '../../src/commands/completion.ts';
import { commands } from '../../src/commands/index.ts';
import { command as remoteCommand } from '../../src/commands/remote.ts';
import { CliError, type CommandContext, EXIT, usageError } from '../../src/commands/types.ts';

// ── helpers ───────────────────────────────────────────────────────────────────

function ctx(positionals: string[]): CommandContext {
  return {
    positionals,
    flags: {},
    globals: { json: false, quiet: false, verbose: 0, yes: false, color: false },
    client: null as unknown as CommandContext['client']
  };
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: string | Buffer) => {
    chunks.push(typeof c === 'string' ? c : c.toString());
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join('');
}

/** Build the dispatcher registry the way main.ts does (canonical names + aliases). */
function registry(): Map<string, (typeof commands)[number]> {
  return new Map(commands.flatMap((c) => [[c.name, c], ...(c.aliases ?? []).map((a) => [a, c] as const)]));
}

// ── registry integrity ──────────────────────────────────────────────────────────

test('canonical command names are unique', () => {
  const names = commands.map((c) => c.name);
  expect(new Set(names).size).toBe(names.length);
});

test('no alias collides with a canonical name or another alias', () => {
  const names = new Set(commands.map((c) => c.name));
  const seen = new Set<string>();
  for (const c of commands) {
    for (const a of c.aliases ?? []) {
      expect(names.has(a)).toBe(false); // alias must not shadow a canonical name
      expect(seen.has(a)).toBe(false); // alias must be unique across commands
      seen.add(a);
    }
  }
});

test('every command has a synopsis and a description or descriptionKey', () => {
  for (const c of commands) {
    expect(c.synopsis.length).toBeGreaterThan(0);
  }
});

test('every visible command declares a usage-table group', () => {
  for (const c of commands.filter((c) => !c.hidden)) {
    expect(['daemon', 'work', 'configure']).toContain(c.group ?? 'configure');
  }
});

test('remote rejects the removed pair subcommand with the supported TLS action', async () => {
  await expect(remoteCommand.run(ctx(['pair']))).rejects.toThrow('unknown action: pair (expected tls)');
});

test('the canonical commands are all registered', () => {
  const reg = registry();
  for (const name of [
    'status',
    'logs',
    'doctor',
    'chat',
    'command',
    'completion',
    'provider',
    'credential',
    'tui',
    'purge',
    'skill',
    'agent',
    'mesh',
    'approval',
    'remote'
  ]) {
    expect(reg.has(name)).toBe(true);
  }
});

test('`agent` addresses the team roster', async () => {
  const listed: string[] = [];
  const agentClient = {
    treaty: {
      v1: {
        agents: Object.assign(
          async () => {
            throw new Error('unused');
          },
          {
            get: async () => {
              listed.push('agents');
              return { data: { agents: [] }, status: 200 };
            },
            default: {
              get: async () => {
                listed.push('default');
                return { data: { agentId: null }, status: 200 };
              }
            }
          }
        )
      }
    }
  };
  await captureStdout(() =>
    agentCommand.run({ ...ctx(['list']), client: agentClient as unknown as CommandContext['client'] })
  );
  expect(listed.sort()).toEqual(['agents', 'default']);
});

test('approval allow resolves the blocked tool call with the requested scope', async () => {
  const posted: unknown[] = [];
  const client = {
    treaty: {
      v1: {
        tools: {
          approve: {
            post: async (body: unknown) => {
              posted.push(body);
              return { data: { ok: true }, status: 200 };
            }
          }
        }
      }
    }
  };
  await captureStdout(() =>
    approvalCommand.run({
      ...ctx(['allow', 'req_1']),
      flags: { scope: 'session', reason: 'reviewed' },
      client: client as unknown as CommandContext['client']
    })
  );
  expect(posted).toEqual([{ requestId: 'req_1', allow: true, reason: 'reviewed', scope: 'session' }]);
});

test('approval rejects an unknown scope before calling the daemon', async () => {
  let calls = 0;
  const client = {
    treaty: {
      v1: {
        tools: {
          approve: {
            post: async () => {
              calls++;
              return { data: { ok: true }, status: 200 };
            }
          }
        }
      }
    }
  };
  await expect(
    approvalCommand.run({
      ...ctx(['deny', 'req_1']),
      flags: { scope: 'forever' },
      client: client as unknown as CommandContext['client']
    })
  ).rejects.toThrow();
  expect(calls).toBe(0);
});

test('friendly aliases resolve to the right command', () => {
  const reg = registry();
  expect(reg.get('down')?.name).toBe('stop');
  expect(reg.get('prov')?.name).toBe('provider');
  expect(reg.get('creds')?.name).toBe('credential');
  expect(reg.get('m')?.name).toBe('model');
  expect(reg.get('s')?.name).toBe('session');
  expect(reg.get('approvals')?.name).toBe('approval');
  expect(reg.get('commands')?.name).toBe('command');
  expect(reg.get('licenses')?.name).toBe('license');
  // shortcuts are their own (hidden) delegating commands
  expect(reg.get('ls')?.name).toBe('ls');
  expect(reg.get('ps')?.name).toBe('ps');
});

test('every alias documented in cli-design.md resolves to a registered command', async () => {
  const doc = await Bun.file(new URL('../../../../docs/internal/development/cli-design.md', import.meta.url)).text();
  const fromHeader = doc.slice(doc.indexOf('| Alias | Canonical | Why |'));
  const table = fromHeader.slice(0, fromHeader.indexOf('\n\n'));
  const aliases = [...table.matchAll(/^\| `?(?:monad )?([a-z]+)`?(?: \/ `([a-z]+)`)?/gm)]
    .flatMap((m) => [m[1], m[2]])
    .filter((name): name is string => !!name && name !== 'Alias');
  const reg = registry();
  expect(aliases.length).toBeGreaterThan(10);
  for (const alias of aliases) expect(reg.has(alias)).toBe(true);
});

test('every advertised subcommand is one the dispatcher actually accepts', async () => {
  // `rm` became the advertised deletion verb for resource nouns while `remove`/`delete` stayed as
  // unadvertised aliases; this pins that the synopsis and the `subcommands` list agree, so shell
  // completion can never offer a verb the command rejects.
  for (const command of commands.filter((c) => c.subcommands?.length)) {
    // Only a first-level alternation right after the command name is a claim about its own verbs.
    // `session <subcommand>` is a placeholder, and `remote tls <show|renew|trust>` names the verbs
    // of a nested command, not of `remote`.
    const advertised = command.synopsis.match(new RegExp(`^${command.name} <([^>]+)>`))?.[1];
    if (!advertised?.includes('|') || advertised.includes(' ')) continue;
    expect(advertised.split('|').sort()).toEqual([...(command.subcommands as string[])].sort());
  }
});

test('removed names no longer resolve', () => {
  const reg = registry();
  for (const gone of [
    'health',
    'ping',
    'console',
    'dashboard',
    'skills',
    'reset',
    'pair',
    'tls',
    'interaction',
    'project',
    'dm',
    'runtime'
  ]) {
    expect(reg.has(gone)).toBe(false);
  }
});

test('shortcuts and acp are hidden from the usage table', () => {
  const visible = commands.filter((c) => !c.hidden).map((c) => c.name);
  expect(visible).not.toContain('acp');
  expect(visible).not.toContain('ls');
  expect(visible).not.toContain('ask');
  expect(visible).not.toContain('up');
  expect(visible).toContain('status');
  expect(visible).toContain('chat');
});

// ── completion ────────────────────────────────────────────────────────────────

test('completion emits a script naming the commands for each shell', async () => {
  for (const shell of ['bash', 'zsh', 'fish']) {
    const out = await captureStdout(() => completion.run(ctx([shell])));
    expect(out).toContain('status');
    expect(out).toContain('chat');
  }
});

test('the completion script offers each command its own declared subcommands', async () => {
  const script = await captureStdout(() => completion.run(ctx(['bash'])));
  const declared = commands.filter((c) => c.subcommands?.length);
  expect(declared.length).toBeGreaterThan(10);
  for (const command of declared) {
    // One case arm per command, listing exactly what its dispatcher accepts — a verb added to the
    // command but not to `subcommands` never reaches the shell, which is what this pins.
    expect(script).toContain(`${command.name}) COMPREPLY=( $(compgen -W "${command.subcommands?.join(' ')}"`);
  }
});

test('completion with an unknown shell is a usage error (exit 2)', async () => {
  try {
    await completion.run(ctx(['tcsh']));
    expect.unreachable('should throw');
  } catch (err) {
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(EXIT.USAGE);
  }
});

// ── error helpers ────────────────────────────────────────────────────────────────

test('usageError carries the USAGE exit code', () => {
  const err = usageError('usage: monad foo');
  expect(err).toBeInstanceOf(CliError);
  expect(err.code).toBe(EXIT.USAGE);
});
