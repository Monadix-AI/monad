import { expect, test } from 'bun:test';

import { buildDevEnv, cleanupDevProcess, devCommand, devSpawnOptions, i18nCommand } from '../../dev.ts';

test('buildDevEnv loads .env.local values without clobbering shell overrides', () => {
  const env = buildDevEnv(
    {
      MONAD_PORT: '52100',
      WEB_PORT: '3100',
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: '/explicit/cache'
    },
    {
      MONAD_PORT: '59999',
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: '/shell/cache',
      PATH: '/bin'
    },
    '/Users/dev'
  );

  expect(env.MONAD_PORT).toBe('59999');
  expect(env.WEB_PORT).toBe('3100');
  expect(env.PORT).toBe('3100');
  expect(env.BUN_RUNTIME_TRANSPILER_CACHE_PATH).toBe('/shell/cache');
});

test('buildDevEnv preserves an explicit shell PORT over WEB_PORT', () => {
  const env = buildDevEnv({ WEB_PORT: '3100' }, { PORT: '7777' }, '/Users/dev');
  expect(env.PORT).toBe('7777');
});

test('devSpawnOptions starts turbo as a process-group leader', () => {
  expect(i18nCommand()).toEqual(['bun', 'run', 'scripts/i18n.ts', '--write-if-stale']);
  expect(devCommand()).toEqual([
    'bunx',
    'turbo',
    'run',
    'start:dev',
    'devtools',
    '--filter=@monad/i18n',
    '--filter=@monad/monad',
    '--filter=@monad/web'
  ]);
  expect(devSpawnOptions('/repo', { PATH: '/bin' })).toMatchObject({
    cwd: '/repo',
    env: { PATH: '/bin' },
    detached: true
  });
});

test('cleanupDevProcess signals the process group first and falls back to the child', () => {
  const signals: string[] = [];
  const proc = {
    pid: 1234,
    kill(signal: NodeJS.Signals) {
      signals.push(`child:${signal}`);
    }
  };

  cleanupDevProcess(proc, 'SIGTERM', {
    platform: 'linux',
    killGroup(pid, signal) {
      signals.push(`group:${pid}:${signal}`);
    },
    taskkill() {
      throw new Error('taskkill should not run on POSIX');
    }
  });

  expect(signals).toEqual(['group:-1234:SIGTERM']);
});

test('cleanupDevProcess falls back to direct child signal when process-group signaling fails', () => {
  const signals: string[] = [];
  const proc = {
    pid: 1234,
    kill(signal: NodeJS.Signals) {
      signals.push(`child:${signal}`);
    }
  };

  cleanupDevProcess(proc, 'SIGTERM', {
    platform: 'linux',
    killGroup() {
      throw new Error('already gone');
    },
    taskkill() {
      throw new Error('taskkill should not run on POSIX');
    }
  });

  expect(signals).toEqual(['child:SIGTERM']);
});

test('cleanupDevProcess uses taskkill for Windows tree termination', () => {
  const calls: string[] = [];
  const proc = {
    pid: 1234,
    kill(signal: NodeJS.Signals) {
      calls.push(`child:${signal}`);
    }
  };

  cleanupDevProcess(proc, 'SIGTERM', {
    platform: 'win32',
    killGroup() {
      throw new Error('process groups should not run on Windows');
    },
    taskkill(pid) {
      calls.push(`taskkill:${pid}`);
    }
  });

  expect(calls).toEqual(['taskkill:1234']);
});
