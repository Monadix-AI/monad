import { expect, test } from 'bun:test';

import {
  buildDevEnv,
  buildDevPrepStepProgressFrame,
  buildDevPrepStepStatusFrame,
  buildDevPrepSummary,
  cleanupDevProcess,
  devCommand,
  devSpawnOptions,
  i18nCommand
} from '../../dev-prep.ts';

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

test('buildDevPrepSummary groups the resolved dev environment for terminal output', () => {
  const lines = buildDevPrepSummary({
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: '/Users/dev/.cache/monad-bun',
    MONAD_KV_UI_PORT: '6401',
    MONAD_HTTP_PORT: '53001',
    MONAD_PORT: '52001',
    PORT: '3101',
    WEB_PORT: '3101'
  });

  expect(lines).toEqual([
    '',
    'Monad dev prep',
    'Ports',
    '  Daemon API        https://127.0.0.1:52001',
    '  Local HTTP        http://127.0.0.1:53001',
    '  Web app           http://127.0.0.1:3101',
    '  KV inspector      http://127.0.0.1:6401',
    'Runtime URL priority',
    '  Daemon proxy      MONAD_URL > config network.host/https/port',
    'Runtime',
    '  Bun transpiler    /Users/dev/.cache/monad-bun',
    'Tasks',
    '  1. Refresh i18n artifacts',
    '  2. Start daemon, web app, and devtools',
    ''
  ]);
});

test('dev-prep step frames support progress animation', () => {
  expect(
    buildDevPrepStepProgressFrame({
      color: false,
      frame: '|',
      label: 'i18n artifacts',
      target: 'scripts/i18n.ts --write-if-stale',
      verb: 'refreshing'
    })
  ).toBe('\r[dev-prep] | refreshing i18n artifacts -> scripts/i18n.ts --write-if-stale');
  expect(
    buildDevPrepStepStatusFrame({
      color: false,
      label: 'i18n artifacts',
      target: 'scripts/i18n.ts --write-if-stale',
      verb: 'refreshed'
    })
  ).toBe('[dev-prep] refreshed i18n artifacts -> scripts/i18n.ts --write-if-stale\n');
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
