import { expect, test } from 'bun:test';
import { chmod, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildManagedProjectCliWrapperScript,
  cleanupManagedProjectOrphanTokens,
  managedProjectCliWrapperName,
  prepareManagedProjectRuntime
} from '@/services/native-cli/managed-project.ts';

test('managed project CLI wrapper uses source entry in development', () => {
  expect(buildManagedProjectCliWrapperScript('/repo/apps/cli/src/main.ts', '/Applications/Monad.app/monad')).toBe(
    '#!/usr/bin/env sh\nexec bun "/repo/apps/cli/src/main.ts" "$@"\n'
  );
});

test('managed project CLI wrapper falls back to the current executable in packaged builds', () => {
  expect(buildManagedProjectCliWrapperScript(null, '/Applications/Monad.app/Contents/MacOS/Monad')).toBe(
    '#!/usr/bin/env sh\nexec "/Applications/Monad.app/Contents/MacOS/Monad" "$@"\n'
  );
});

test('managed project CLI wrapper creates a Windows cmd shim in development', () => {
  expect(
    buildManagedProjectCliWrapperScript(
      'C:\\repo\\apps\\cli\\src\\main.ts',
      'C:\\Program Files\\Monad\\Monad.exe',
      'win32'
    )
  ).toBe('@echo off\r\nbun "C:\\repo\\apps\\cli\\src\\main.ts" %*\r\n');
});

test('managed project CLI wrapper creates a Windows cmd shim in packaged builds', () => {
  expect(buildManagedProjectCliWrapperScript(null, 'C:\\Program Files\\Monad\\Monad.exe', 'win32')).toBe(
    '@echo off\r\n"C:\\Program Files\\Monad\\Monad.exe" %*\r\n'
  );
});

test('managed project runtime uses the platform wrapper filename', async () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  const prepared = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'codex',
    projectSessionId: 'ses_PROJECT',
    nativeCliSessionId: 'ncli_windows',
    provider: 'codex',
    platform: 'win32'
  });

  expect(prepared.wrapperBin.endsWith(`${managedProjectCliWrapperName('win32')}`)).toBe(true);
  expect(await readFile(prepared.wrapperBin, 'utf8')).toStartWith('@echo off\r\n');
});

test('managed project runtime rejects agent names that escape the project workspace', async () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  const escapedWorkspace = join(monadHome, 'escaped-agent');

  expect(() =>
    prepareManagedProjectRuntime({
      monadHome,
      serverUrl: 'http://127.0.0.1:1234',
      agentName: '../../escaped-agent',
      projectSessionId: 'ses_PROJECT',
      nativeCliSessionId: 'ncli_escape',
      provider: 'codex'
    })
  ).toThrow('managed native CLI workspace must stay inside the project agent root');
  expect(await readFile(join(escapedWorkspace, '.monad-agent-token'), 'utf8').catch(() => null)).toBeNull();
  expect(await readFile(join(escapedWorkspace, 'managed-prompt.md'), 'utf8').catch(() => null)).toBeNull();
});

test('managed project runtime rotates its agent token for each prepared native CLI session', async () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  const first = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'codex',
    projectSessionId: 'ses_PROJECT',
    nativeCliSessionId: 'ncli_first',
    provider: 'codex'
  });
  const firstToken = await readFile(first.tokenFile, 'utf8');
  const second = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'codex',
    projectSessionId: 'ses_PROJECT',
    nativeCliSessionId: 'ncli_second',
    provider: 'codex'
  });

  expect(await readFile(second.tokenFile, 'utf8')).not.toBe(firstToken);
  expect(second.tokenHash).not.toBe(first.tokenHash);
});

test('managed project runtime recreates token files with owner-only permissions', async () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  const workspace = join(monadHome, 'workplace-agents', 'ses_PROJECT', 'codex');
  await mkdir(workspace, { recursive: true });
  const tokenFile = join(workspace, '.monad-agent-token');
  await writeFile(tokenFile, 'stale-token');
  await chmod(tokenFile, 0o644);

  const prepared = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'codex',
    projectSessionId: 'ses_PROJECT',
    nativeCliSessionId: 'ncli_first',
    provider: 'codex'
  });

  expect(prepared.tokenFile).toBe(tokenFile);
  expect(await readFile(tokenFile, 'utf8')).not.toBe('stale-token');
  expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
});

test('managed project orphan token cleanup removes stale runtime tokens without deleting memory', async () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  const workspace = join(monadHome, 'workplace-agents', 'ses_PROJECT', 'codex');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, '.monad-agent-token'), 'stale-token');
  await writeFile(join(workspace, 'MEMORY.md'), '# durable memory\n');

  expect(cleanupManagedProjectOrphanTokens(monadHome)).toBe(1);
  expect(await readFile(join(workspace, '.monad-agent-token'), 'utf8').catch(() => null)).toBeNull();
  expect(await readFile(join(workspace, 'MEMORY.md'), 'utf8')).toBe('# durable memory\n');
});

test('managed project orphan token cleanup does not follow workspace symlink directories', async () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  const external = join(tmpdir(), `monad-managed-runtime-external-${Date.now()}-${process.hrtime.bigint()}`);
  await mkdir(join(monadHome, 'workplace-agents'), { recursive: true });
  await mkdir(external, { recursive: true });
  await writeFile(join(external, '.monad-agent-token'), 'external-token');
  await symlink(external, join(monadHome, 'workplace-agents', 'linked-external'), 'dir');

  expect(cleanupManagedProjectOrphanTokens(monadHome)).toBe(0);
  expect(await readFile(join(external, '.monad-agent-token'), 'utf8')).toBe('external-token');
});
