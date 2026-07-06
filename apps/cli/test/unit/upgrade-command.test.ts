import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MONAD_VERSION } from '@monad/protocol';

import { type CommandContext } from '../../src/commands/types.ts';
import { createUpgradeCommand, command as upgrade } from '../../src/commands/upgrade.ts';
import { setOutputMode } from '../../src/lib/output.ts';

class ExitSignal extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

const originalFetch = globalThis.fetch;
const originalSpawn = Bun.spawn;
const originalExit = process.exit;
const originalExecPath = process.execPath;
const originalHome = Bun.env.MONAD_HOME;

let home: string;
let execPath: string;
let output = '';
let spawnCalls: string[][] = [];

const installScriptName = process.platform === 'win32' ? 'install.ps1' : 'install.sh';
const installScriptContent = process.platform === 'win32' ? '<# install #>\n' : '#!/usr/bin/env bash\necho install\n';

function ctx(positionals: string[], flags: Record<string, unknown>, json = false): CommandContext {
  return {
    positionals,
    flags,
    globals: { json, quiet: false, verbose: 0, yes: false, color: false },
    client: {} as CommandContext['client']
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

function installFetch(routes: Record<string, Response | (() => Response)>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const value = Object.entries(routes).find(([needle]) => url.includes(needle))?.[1];
    if (!value) return response({}, 404);
    return typeof value === 'function' ? value() : value;
  }) as typeof fetch;
}

function installSpawn(exitCode = 0): void {
  Bun.spawn = ((args: string[]) => {
    spawnCalls.push(args);
    return { exited: Promise.resolve(exitCode) };
  }) as typeof Bun.spawn;
}

async function runCommand(commandCtx: CommandContext, command = upgrade): Promise<void> {
  await command.run(commandCtx);
}

async function makeBackup(name: string, mtimeOffset: number, content = name): Promise<void> {
  const backupDir = join(home, 'backup', 'binaries');
  await mkdir(backupDir, { recursive: true });
  const path = join(backupDir, name);
  await writeFile(path, content);
  const date = new Date(Date.now() + mtimeOffset);
  await utimes(path, date, date);
}

beforeEach(async () => {
  home = join(tmpdir(), `monad-upgrade-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  execPath = join(home, 'bin', 'monad');
  await mkdir(join(home, 'bin'), { recursive: true });
  await writeFile(execPath, 'current-binary');
  process.execPath = execPath;
  Bun.env.MONAD_HOME = home;
  output = '';
  spawnCalls = [];
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.exit = ((code?: number) => {
    throw new ExitSignal(code);
  }) as typeof process.exit;
  setOutputMode({ format: 'human', quiet: false, color: false });
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  Bun.spawn = originalSpawn;
  process.exit = originalExit;
  process.execPath = originalExecPath;
  process.stdout.write = originalStdoutWrite;
  Bun.env.MONAD_HOME = originalHome;
  setOutputMode({ format: 'human', quiet: false, color: false });
  await rm(home, { recursive: true, force: true });
});

const originalStdoutWrite = process.stdout.write.bind(process.stdout);

test('upgrade --check --json treats v-prefixed current release tags as up to date', async () => {
  setOutputMode({ format: 'json', quiet: false, color: false });
  installFetch({ '/releases/latest': response({ tag_name: `v${MONAD_VERSION}` }) });

  await runCommand(ctx([], { check: true }, true));

  const payload = JSON.parse(output) as { current: string; latest: string; upToDate: boolean; channel: string };
  expect(payload).toEqual({ current: MONAD_VERSION, latest: MONAD_VERSION, upToDate: true, channel: 'stable' });
});

test('upgrade --check reports available updates without installing', async () => {
  installFetch({ '/releases/latest': response({ tag_name: 'v9.9.9' }) });

  await runCommand(ctx([], { check: true }));

  expect(output).toContain('9.9.9');
});

test('upgrade --notes prints truncated release notes', async () => {
  const notes = Array.from({ length: 25 }, (_, index) => `line ${index + 1}`).join('\n');
  installFetch({ '/releases/latest': () => response({ tag_name: 'v9.9.9', body: notes }) });

  await runCommand(ctx([], { check: true, notes: true }));

  expect(output).toContain('line 1');
  expect(output).toContain('line 20');
  expect(output).not.toContain('line 21');
  expect(output).toContain('…');
});

test('upgrade installs via verified script and backs up the current binary', async () => {
  const script = installScriptContent;
  const hash = new Bun.CryptoHasher('sha256').update(new TextEncoder().encode(script)).digest('hex');
  installFetch({
    '/releases/latest': response({ tag_name: 'v9.9.9' }),
    [`/${installScriptName}.sha256`]: response(`${hash}  ${installScriptName}`),
    [`/scripts/${installScriptName}`]: response(script)
  });
  installSpawn(0);

  await runCommand(ctx([], {}));

  expect(spawnCalls).toHaveLength(1);
  expect(spawnCalls[0]?.[0]).toBe(process.platform === 'win32' ? 'powershell' : 'bash');
  expect(await Bun.file(join(home, 'backup', 'binaries', `monad-${MONAD_VERSION}`)).text()).toBe('current-binary');
  expect(output).toContain('SHA-256');
});

test('upgrade beta selects the first prerelease and passes the channel to the installer', async () => {
  const hash = new Bun.CryptoHasher('sha256').update(new TextEncoder().encode(installScriptContent)).digest('hex');
  installFetch({
    '/releases?per_page=50': response([
      { tag_name: 'v9.9.9', prerelease: false },
      { tag_name: 'v10.0.0-beta.1', prerelease: true }
    ]),
    [`/${installScriptName}.sha256`]: response(`${hash}  ${installScriptName}`),
    [`/scripts/${installScriptName}`]: response(installScriptContent)
  });
  installSpawn(0);

  await runCommand(ctx([], { channel: 'beta' }));

  expect(output).toContain('10.0.0-beta.1');
  if (process.platform === 'win32') {
    expect(spawnCalls[0]).toContain('-File');
  } else {
    expect(spawnCalls[0]?.slice(-2)).toEqual(['--channel', 'beta']);
  }
});

test('upgrade exits before install when release lookup fails', async () => {
  installFetch({ '/releases/latest': response({}, 500) });
  installSpawn(0);

  await expect(runCommand(ctx([], {}))).rejects.toMatchObject({ code: 1 });
});

test('upgrade aborts when install script hash mismatches', async () => {
  installFetch({
    '/releases/latest': response({ tag_name: 'v9.9.9' }),
    [`/${installScriptName}.sha256`]: response('0'.repeat(64)),
    [`/scripts/${installScriptName}`]: response(installScriptContent)
  });
  installSpawn(0);

  await expect(runCommand(ctx([], {}))).rejects.toMatchObject({ code: 1 });
  expect(output).toContain('SHA-256');
});

test('upgrade aborts when the install script hash is missing', async () => {
  installFetch({
    '/releases/latest': response({ tag_name: 'v9.9.9' }),
    [`/${installScriptName}.sha256`]: response('', 404),
    [`/scripts/${installScriptName}`]: response(installScriptContent)
  });
  installSpawn(0);

  await expect(runCommand(ctx([], {}))).rejects.toMatchObject({ code: 1 });
  expect(output).toContain(`${installScriptName}.sha256`);
});

test('upgrade aborts on Windows when the install script hash is missing', async () => {
  const command = createUpgradeCommand({ binaryPath: execPath, platform: 'win32' });
  const script = '<# install #>\n';
  installFetch({
    '/releases/latest': response({ tag_name: 'v9.9.9' }),
    '/install.ps1.sha256': response('', 404),
    '/scripts/install.ps1': response(script)
  });
  installSpawn(0);

  await expect(runCommand(ctx([], {}), command)).rejects.toMatchObject({ code: 1 });
  expect(output).toContain('install.ps1.sha256');
});

test('upgrade aborts when the install script hash is invalid', async () => {
  installFetch({
    '/releases/latest': response({ tag_name: 'v9.9.9' }),
    [`/${installScriptName}.sha256`]: response(`not-a-sha  ${installScriptName}`),
    [`/scripts/${installScriptName}`]: response(installScriptContent)
  });
  installSpawn(0);

  await expect(runCommand(ctx([], {}))).rejects.toMatchObject({ code: 1 });
  expect(output).toContain(`${installScriptName}.sha256`);
});

test('upgrade forwards installer failures as the process exit code', async () => {
  const hash = new Bun.CryptoHasher('sha256').update(new TextEncoder().encode(installScriptContent)).digest('hex');
  installFetch({
    '/releases/latest': response({ tag_name: 'v9.9.9' }),
    [`/${installScriptName}.sha256`]: response(`${hash}  ${installScriptName}`),
    [`/scripts/${installScriptName}`]: response(installScriptContent)
  });
  installSpawn(42);

  await expect(runCommand(ctx([], {}))).rejects.toMatchObject({ code: 42 });
});

test('upgrade rollback restores the newest backup to the current binary path', async () => {
  await makeBackup('monad-0.1.0', -2000, 'old');
  await makeBackup('monad-0.2.0', -1000, 'newest');

  await runCommand(ctx(['rollback'], {}));

  expect(await Bun.file(execPath).text()).toBe('newest');
  expect(output).toContain('monad-0.2.0');
});

test('upgrade rollback --json reports no-backup without exiting', async () => {
  setOutputMode({ format: 'json', quiet: false, color: false });

  await runCommand(ctx(['rollback'], {}, true));

  expect(JSON.parse(output)).toEqual({ ok: false, reason: 'no-backup' });
});

test('upgrade --prune-backups keeps the three newest binary backups', async () => {
  for (let i = 0; i < 5; i++) await makeBackup(`monad-0.0.${i}`, i);
  await makeBackup('not-monad', 10);

  await runCommand(ctx([], { 'prune-backups': true }));

  const names = (await readdir(join(home, 'backup', 'binaries'))).sort();
  expect(names).toEqual(['monad-0.0.2', 'monad-0.0.3', 'monad-0.0.4', 'not-monad']);
  expect((await stat(join(home, 'backup', 'binaries', 'not-monad'))).isFile()).toBe(true);
});
