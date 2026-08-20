if (process.platform === 'win32') process.exit(0);

import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configureShell, createSandboxBackends, findGitBash, shellArgv } from '#/capabilities/tools/backends.ts';
import { configureSandboxReadDeny } from '#/capabilities/tools/index.ts';

afterEach(() => {
  // Reset the lazy shell cache so tests don't bleed into each other.
  configureShell({});
  configureSandboxReadDeny([]);
});

test('findGitBash returns null on non-Windows', () => {
  expect(findGitBash('/bin/bash')).toBeNull();
});

test('shellArgv produces /bin/sh -c on non-Windows', () => {
  configureShell({});
  expect(shellArgv('echo hi')).toEqual(['/bin/sh', '-c', 'echo hi']);
});

test('configureShell overrides the shell binary', () => {
  configureShell({ shellPath: '/usr/bin/bash' });
  expect(shellArgv('echo hi')).toEqual(['/usr/bin/bash', '-c', 'echo hi']);
});

test('sandbox fs backend denies direct and symlinked Credential vault access for every mutation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'monad-backends-unix-'));
  try {
    const workspace = join(dir, 'workspace');
    const vault = join(dir, 'config', 'auth.json');
    const credentials = join(dir, 'config', 'credentials');
    const link = join(workspace, 'vault-link.json');
    const credentialsLink = join(workspace, 'credentials-link');
    await Bun.write(vault, 'real-secret-canary');
    await Bun.write(join(credentials, 'marker'), 'real-secret-canary');
    await Bun.write(join(workspace, 'ordinary.txt'), 'ordinary');
    await symlink(vault, link);
    await symlink(credentials, credentialsLink);
    configureSandboxReadDeny([vault, credentials]);
    const { fs } = createSandboxBackends([dir]);
    if (!fs.deleteFile || !fs.moveFile) throw new Error('sandbox fs mutations unavailable');

    await expect(fs.readTextFile(vault)).rejects.toThrow('sandbox path denied');
    await expect(fs.readTextFile(link)).rejects.toThrow('sandbox path denied');
    await expect(fs.writeTextFile(vault, 'replacement')).rejects.toThrow('sandbox path denied');
    await expect(fs.deleteFile(vault)).rejects.toThrow('sandbox path denied');
    await expect(fs.moveFile(vault, join(workspace, 'moved.json'))).rejects.toThrow('sandbox path denied');
    await expect(fs.moveFile(join(workspace, 'ordinary.txt'), vault)).rejects.toThrow('sandbox path denied');
    await expect(fs.writeTextFile(join(credentialsLink, 'new', 'secret.txt'), 'replacement')).rejects.toThrow(
      'sandbox path denied'
    );
    expect({ vault: await Bun.file(vault).text(), createdCredentialDir: existsSync(join(credentials, 'new')) }).toEqual(
      {
        vault: 'real-secret-canary',
        createdCredentialDir: false
      }
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
