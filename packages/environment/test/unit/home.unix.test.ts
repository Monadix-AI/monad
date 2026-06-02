if (process.platform === 'win32') process.exit(0);

import type { MonadPaths } from '../../src/paths.ts';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initMonadHome } from '../../src/init.ts';

function makePaths(base: string): MonadPaths {
  const runtime = join(base, 'runtime');
  const credentials = join(base, 'credentials');
  return {
    home: base,
    runtime,
    configs: join(base, 'configs'),
    config: join(base, 'configs', 'config.json'),
    agentsConfig: join(base, 'configs', 'agents.json'),
    mesh: join(base, 'configs', 'mesh.json'),
    approvals: join(base, 'configs', 'approvals.json'),
    credentials,
    auth: join(credentials, 'auth.json'),
    tls: join(credentials, 'tls'),
    workspace: join(base, 'agents', 'default'),
    providers: join(base, 'atoms', 'providers'),
    skills: join(base, 'atoms', 'skills'),
    skillsLock: join(base, 'atoms', 'skills.lock'),
    locales: join(base, 'atoms', 'locales'),
    mcp: join(base, 'atoms', 'mcp'),
    atoms: join(base, 'atoms'),
    packs: join(base, 'atoms', 'packs'),
    agents: join(base, 'agents'),
    memory: join(base, 'memory'),
    cache: join(base, 'cache'),
    logs: join(base, 'logs'),
    dbDir: join(base, 'db'),
    db: join(base, 'db', 'monad.sqlite'),
    backup: join(base, 'backup'),
    bin: join(base, 'bin'),
    sock: join(runtime, 'monad.sock'),
    kvSock: join(runtime, 'kv.sock'),
    pid: join(runtime, 'monad.pid')
  };
}

let testDir: string;
let paths: MonadPaths;

beforeEach(() => {
  testDir = join(tmpdir(), `monad-test-${Date.now()}`);
  paths = makePaths(testDir);
});

afterEach(async () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rm(testDir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw err;
      await Bun.sleep(100);
    }
  }
});

describe('initMonadHome unix permissions', () => {
  test('locks credentials/ to owner-only (mode 0o700)', async () => {
    await initMonadHome(paths);
    const { mode } = await stat(paths.credentials);
    expect(mode & 0o777).toBe(0o700);
  });
});

describe('saveAuth permissions', () => {
  test('auth.json is created with mode 600 on unix', async () => {
    await initMonadHome(paths);
    const { mode } = await stat(paths.auth);
    expect(mode & 0o777).toBe(0o600);
  });

  test('config.json is created with mode 600 on unix (holds remoteAccess.token)', async () => {
    await initMonadHome(paths);
    const { mode } = await stat(paths.config);
    expect(mode & 0o777).toBe(0o600);
  });
});
