import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { command as tls } from '../../src/commands/tls.ts';
import { type CommandContext } from '../../src/commands/types.ts';
import { setOutputMode } from '../../src/lib/output.ts';

const originalHome = Bun.env.MONAD_HOME;
const originalUserHome = Bun.env.HOME;
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const originalSpawnSync = Bun.spawnSync;
const originalStdoutWrite = process.stdout.write.bind(process.stdout);

let home: string;
let output = '';
let spawnCalls: string[][] = [];

function ctx(positionals: string[], json = false): CommandContext {
  return {
    positionals,
    flags: {},
    globals: { json, quiet: false, verbose: 0, yes: false, color: false },
    client: {} as CommandContext['client']
  };
}

beforeEach(async () => {
  home = join(tmpdir(), `monad-tls-command-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(home, 'credentials', 'tls'), { recursive: true });
  await writeFile(join(home, 'credentials', 'tls', 'cert.pem'), 'cert');
  await writeFile(join(home, 'credentials', 'tls', 'key.pem'), 'key');
  Bun.env.MONAD_HOME = home;
  Bun.env.HOME = home;
  output = '';
  spawnCalls = [];
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  Bun.spawnSync = ((args: string[]) => {
    spawnCalls.push(args);
    if (args.includes('-fingerprint')) {
      return {
        exitCode: 0,
        stderr: new Uint8Array(),
        stdout: new TextEncoder().encode('sha256 Fingerprint=AA:BB\n')
      };
    }
    if (args.includes('-enddate')) {
      return {
        exitCode: 0,
        stderr: new Uint8Array(),
        stdout: new TextEncoder().encode('notAfter=Jul 09 00:00:00 2027 GMT\n')
      };
    }
    return { exitCode: 0, stderr: new Uint8Array(), stdout: new Uint8Array() };
  }) as typeof Bun.spawnSync;
});

afterEach(async () => {
  Bun.env.MONAD_HOME = originalHome;
  Bun.env.HOME = originalUserHome;
  Bun.spawnSync = originalSpawnSync;
  process.stdout.write = originalStdoutWrite;
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  setOutputMode({ format: 'human', quiet: false, color: false });
  await rm(home, { recursive: true, force: true });
});

test('tls trust installs the daemon certificate into the macOS login keychain', async () => {
  setOutputMode({ format: 'json', quiet: false, color: false });

  await tls.run(ctx(['trust'], true));

  const certPath = join(home, 'credentials', 'tls', 'cert.pem');
  expect(spawnCalls).toContainEqual([
    'security',
    'add-trusted-cert',
    '-d',
    '-r',
    'trustRoot',
    '-p',
    'ssl',
    '-k',
    join(home, 'Library', 'Keychains', 'login.keychain-db'),
    certPath
  ]);
  expect(JSON.parse(output)).toEqual({
    action: 'trust',
    certPath,
    fingerprint: 'AA:BB',
    keychain: join(home, 'Library', 'Keychains', 'login.keychain-db')
  });
});
