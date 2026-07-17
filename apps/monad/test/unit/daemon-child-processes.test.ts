import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  daemonChildSupervisorArgv,
  daemonChildSupervisorLauncherArgv,
  killDaemonProcessTree,
  runDaemonChildSupervisor
} from '#/infra/daemon-child-processes.ts';

test('killDaemonProcessTree uses taskkill for Windows process trees', () => {
  const commands: string[][] = [];

  killDaemonProcessTree(1234, {
    platform: 'win32',
    spawnSync: (argv) => {
      commands.push(argv);
    }
  });

  expect(commands).toEqual([['taskkill', '/T', '/F', '/PID', '1234']]);
});

test('killDaemonProcessTree signals a POSIX process group before falling back to the leader pid', () => {
  const signals: Array<[number, NodeJS.Signals]> = [];

  killDaemonProcessTree(1234, {
    platform: 'linux',
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      if (pid < 0) throw Object.assign(new Error('not a group leader'), { code: 'ESRCH' });
    }
  });

  expect(signals).toEqual([
    [-1234, 'SIGTERM'],
    [1234, 'SIGTERM']
  ]);
});

test('daemonChildSupervisorArgv re-enters the current daemon entrypoint', () => {
  expect(
    daemonChildSupervisorArgv({
      execPath: '/usr/local/bin/bun',
      entryPath: '/repo/apps/monad/src/main.ts',
      parentPid: 42,
      registryPath: '/tmp/daemon-child-processes.json'
    })
  ).toEqual([
    '/usr/local/bin/bun',
    '/repo/apps/monad/src/main.ts',
    '--daemon-child-supervisor',
    '42',
    '/tmp/daemon-child-processes.json'
  ]);
});

test('daemonChildSupervisorArgv self-execs the compiled binary (no entryPath arg) in release, where execPath and entryPath match', () => {
  expect(
    daemonChildSupervisorArgv({
      execPath: '/opt/monad/bin/monad',
      entryPath: '/opt/monad/bin/monad',
      parentPid: 42,
      registryPath: '/tmp/daemon-child-processes.json'
    })
  ).toEqual(['/opt/monad/bin/monad', '--daemon-child-supervisor', '42', '/tmp/daemon-child-processes.json']);
});

// A compiled Bun binary's `import.meta.path` is a virtual `/$bunfs/root/...` path that never equals
// `process.execPath` — so `entryPath !== execPath` is true in release too, not just dev. argv[0]
// role selection must not be gated on that comparison, or the sibling rename silently never fires.
let watchdogDir: string;
beforeEach(async () => {
  watchdogDir = await mkdtemp(join(tmpdir(), 'monad-watchdog-'));
  await writeFile(join(watchdogDir, 'monad'), '', { mode: 0o755 });
  await symlink('monad', join(watchdogDir, 'monad-watchdog'));
});
afterEach(async () => {
  await rm(watchdogDir, { recursive: true, force: true });
});

test('daemonChildSupervisorArgv self-execs the role-named sibling even when entryPath is a compiled binary virtual path (always != execPath)', () => {
  const execPath = join(watchdogDir, 'monad');
  expect(
    daemonChildSupervisorArgv({
      execPath,
      entryPath: '/$bunfs/root/monad',
      parentPid: 42,
      registryPath: '/tmp/daemon-child-processes.json'
    })
  ).toEqual([
    join(watchdogDir, 'monad-watchdog'),
    '/$bunfs/root/monad',
    '--daemon-child-supervisor',
    '42',
    '/tmp/daemon-child-processes.json'
  ]);
});

test('daemonChildSupervisorLauncherArgv daemonizes through nohup on POSIX', () => {
  expect(
    daemonChildSupervisorLauncherArgv(['bun', 'main.ts', '--daemon-child-supervisor', '42', '/tmp/pids'], 'darwin')
  ).toEqual([
    '/bin/sh',
    '-c',
    'nohup "$@" >/dev/null 2>&1 &',
    'daemon-child-supervisor',
    'bun',
    'main.ts',
    '--daemon-child-supervisor',
    '42',
    '/tmp/pids'
  ]);
});

test('daemonChildSupervisorLauncherArgv launches directly on Windows', () => {
  expect(
    daemonChildSupervisorLauncherArgv(['bun', 'main.ts', '--daemon-child-supervisor', '42', 'C:\\pids.json'], 'win32')
  ).toEqual(['bun', 'main.ts', '--daemon-child-supervisor', '42', 'C:\\pids.json']);
});

test('runDaemonChildSupervisor kills persisted children once the daemon pid is gone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'daemon-child-supervisor-'));
  const registryPath = join(dir, 'children.json');
  await writeFile(
    registryPath,
    JSON.stringify([
      { pid: 111, label: 'external-agent' },
      { pid: 222, label: 'mcp:stdio' }
    ])
  );
  const killed: number[] = [];

  await runDaemonChildSupervisor({
    parentPid: 999,
    registryPath,
    isPidAlive: () => false,
    sleep: async () => {},
    killTree: (pid) => killed.push(pid)
  });

  expect(killed).toEqual([111, 222]);
  expect(await readFile(registryPath, 'utf8').catch(() => '')).toBe('');
  await rm(dir, { recursive: true, force: true });
});
