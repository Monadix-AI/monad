import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildDevEnv,
  buildDevPrepStepProgressFrame,
  buildDevPrepStepStatusFrame,
  buildDevPrepSummary,
  cleanupDevProcess,
  devCommand,
  devSpawnOptions,
  i18nCommand,
  lookupPortPids,
  reportPortSurvivors
} from '../../dev-prep.ts';

const repoRoot = join(import.meta.dir, '..', '..', '..');

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

test('buildDevEnv derives missing Storybook ports from the worktree root', () => {
  const env = buildDevEnv({ WEB_PORT: '3100' }, {}, '/Users/dev', '/some/worktree');
  expect(env.WEB_STORYBOOK_PORT).toBe('4950');
  expect(env.UI_STORYBOOK_PORT).toBe('9250');
});

test('devSpawnOptions starts turbo as a process-group leader', () => {
  expect(i18nCommand()).toEqual(['bun', 'run', 'scripts/i18n.ts', '--write-if-stale']);
  expect(devCommand()).toEqual([
    'bunx',
    'turbo',
    'run',
    '@monad/i18n#start:dev',
    '@monad/monad#start:dev',
    '@monad/monad#devtools',
    '@monad/web#start:dev',
    '@monad/ui#storybook',
    '@monad/web#storybook'
  ]);
  expect(devSpawnOptions('/repo', { PATH: '/bin' })).toMatchObject({
    cwd: '/repo',
    env: { PATH: '/bin' },
    detached: true
  });
});

test('monad dev task enters through the CLI daemon so web routes are mounted', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'apps/monad/package.json'), 'utf-8')) as {
    scripts?: Record<string, string>;
  };

  expect(pkg.scripts?.['start:dev']).toContain('../cli/src/bin.ts daemon');
  expect(pkg.scripts?.['start:dev']).toContain('--env-file=../../.env.local');
});

test('buildDevPrepSummary groups the resolved dev environment for terminal output', () => {
  const lines = buildDevPrepSummary({
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: '/Users/dev/.cache/monad-bun',
    MONAD_KV_UI_PORT: '6401',
    MONAD_HTTP_PORT: '53001',
    MONAD_PORT: '52001',
    PORT: '3101',
    UI_STORYBOOK_PORT: '6007',
    WEB_PORT: '3101',
    WEB_STORYBOOK_PORT: '6006'
  });

  expect(lines).toEqual([
    '',
    'Monad dev prep',
    'Ports',
    '  Daemon API        https://127.0.0.1:52001',
    '  Local HTTP        http://127.0.0.1:53001',
    '  Web app           http://127.0.0.1:3101',
    '  Web Storybook     http://127.0.0.1:6006',
    '  UI Storybook      http://127.0.0.1:6007',
    '  KV inspector      http://127.0.0.1:6401',
    'Runtime URL priority',
    '  Daemon proxy      MONAD_URL > config network.host/https/port',
    'Runtime',
    '  Bun transpiler    /Users/dev/.cache/monad-bun',
    'Tasks',
    '  1. Refresh i18n artifacts',
    '  2. Start daemon, web app, Storybook, and devtools',
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

test('port survivor diagnostics warn without killing the occupying process', () => {
  const warnings: string[] = [];
  const lookedUp: string[] = [];

  reportPortSurvivors(
    { MONAD_PORT: '52147', UI_STORYBOOK_PORT: '6007', WEB_PORT: '3247', WEB_STORYBOOK_PORT: '6006' },
    (message) => warnings.push(message),
    (port) => {
      lookedUp.push(port);
      return port === '52147' || port === '6007' ? ['991'] : [];
    },
    'darwin'
  );

  expect(lookedUp).toEqual(['3247', '52147', '6006', '6007']);
  expect(warnings).toEqual([
    '[dev-prep] port 52147 is still occupied by PID 991; inspect it with: lsof -nP -iTCP:52147 -sTCP:LISTEN',
    '[dev-prep] port 6007 is still occupied by PID 991; inspect it with: lsof -nP -iTCP:6007 -sTCP:LISTEN'
  ]);
});

test('port survivor lookup only returns listeners', () => {
  const calls: string[][] = [];

  lookupPortPids('3000', (command) => {
    calls.push(command);
    return {
      stdout: Buffer.from('123\n'),
      stderr: Buffer.from('')
    };
  });

  expect(calls).toEqual([['lsof', '-tiTCP:3000', '-sTCP:LISTEN']]);
});
