import { expect, test } from 'bun:test';

import { command as completion } from '../../src/commands/completion.ts';
import { commands } from '../../src/commands/index.ts';
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

test('the new canonical commands are all registered', () => {
  const reg = registry();
  for (const name of [
    'status',
    'logs',
    'doctor',
    'chat',
    'commands',
    'completion',
    'provider',
    'credential',
    'tui',
    'purge',
    'skill',
    'project',
    'agent',
    'runtime'
  ]) {
    expect(reg.has(name)).toBe(true);
  }
});

test('agent-facing project and direct-agent commands stay separate', () => {
  const reg = registry();
  expect(reg.get('project')?.synopsis).toContain('project <post|ask|read|inbox>');
  expect(reg.get('agent')?.synopsis).toContain('agent <send|read>');
  expect(reg.get('runtime')?.synopsis).toContain('runtime info');
  expect(reg.has('message')).toBe(false);
});

test('friendly aliases resolve to the right command', () => {
  const reg = registry();
  expect(reg.get('down')?.name).toBe('stop');
  expect(reg.get('prov')?.name).toBe('provider');
  expect(reg.get('creds')?.name).toBe('credential');
  expect(reg.get('m')?.name).toBe('model');
  expect(reg.get('s')?.name).toBe('session');
  // shortcuts are their own (hidden) delegating commands
  expect(reg.get('ls')?.name).toBe('ls');
  expect(reg.get('ps')?.name).toBe('ps');
});

test('removed names no longer resolve', () => {
  const reg = registry();
  for (const gone of ['health', 'ping', 'console', 'dashboard', 'skills']) {
    expect(reg.has(gone)).toBe(false);
  }
});

test('shortcuts and acp are hidden from the usage table', () => {
  const visible = commands.filter((c) => !c.hidden).map((c) => c.name);
  expect(visible).not.toContain('acp');
  expect(visible).not.toContain('ls');
  expect(visible).not.toContain('ask');
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
