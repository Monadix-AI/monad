import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStartupSettingsModule } from '@/handlers/settings/startup/index.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'monad-startup-settings-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('macOS startup setting writes and removes a LaunchAgent', async () => {
  const mod = createStartupSettingsModule({
    platform: 'darwin',
    homeDir: dir,
    monadHome: join(dir, '.monad'),
    command: ['/Applications/Monad.app/Contents/MacOS/monad', 'daemon'],
    logPath: join(dir, '.monad', 'logs', 'startup.log')
  });

  expect(await mod.getStartupSettings()).toMatchObject({ enabled: false, supported: true, platform: 'darwin' });

  const enabled = await mod.setStartupSettings({ enabled: true });
  expect(enabled.enabled).toBe(true);

  const plist = await readFile(join(dir, 'Library', 'LaunchAgents', 'ai.monad.daemon.plist'), 'utf8');
  expect(plist).toContain(join(dir, '.monad'));

  expect((await mod.setStartupSettings({ enabled: false })).enabled).toBe(false);
  expect(await mod.getStartupSettings()).toMatchObject({ enabled: false, supported: true });
});

test('Windows startup setting writes and removes a startup command file', async () => {
  const appDataDir = join(dir, 'Redirected', 'Roaming');
  const mod = createStartupSettingsModule({
    platform: 'win32',
    homeDir: dir,
    appDataDir,
    monadHome: join(dir, 'Monad Home'),
    command: ['C:\\Program Files\\Monad\\monad.exe', 'daemon'],
    logPath: join(dir, 'Monad Home', 'logs', 'startup.log')
  });

  expect(await mod.setStartupSettings({ enabled: true })).toMatchObject({ enabled: true, supported: true });

  const _script = await readFile(
    join(appDataDir, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Monad.cmd'),
    'utf8'
  );

  expect((await mod.setStartupSettings({ enabled: false })).enabled).toBe(false);
});

test('Linux startup setting writes and removes an XDG autostart desktop file', async () => {
  const mod = createStartupSettingsModule({
    platform: 'linux',
    homeDir: dir,
    monadHome: join(dir, '.monad'),
    command: ['/usr/local/bin/monad', 'daemon'],
    logPath: join(dir, '.monad', 'logs', 'startup.log')
  });

  expect(await mod.setStartupSettings({ enabled: true })).toMatchObject({ enabled: true, supported: true });

  const _desktop = await readFile(join(dir, '.config', 'autostart', 'monad.desktop'), 'utf8');

  expect((await mod.setStartupSettings({ enabled: false })).enabled).toBe(false);
});
