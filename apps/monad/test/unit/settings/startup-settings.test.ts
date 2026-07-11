import { afterEach, beforeEach, expect, test } from 'bun:test';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStartupSettingsModule } from '#/handlers/settings/startup/index.ts';

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
  expect(plist).toContain('Monad.app/Contents/MacOS/monad-startup');

  const appInfo = await readFile(join(dir, '.monad', 'startup', 'Monad.app', 'Contents', 'Info.plist'), 'utf8');
  expect(appInfo).toContain('<string>Monad</string>');
  expect(appInfo).toContain('<string>Monadix Labs, Inc.</string>');
  expect(appInfo).toContain('MonadIcon');

  const launcher = await readFile(
    join(dir, '.monad', 'startup', 'Monad.app', 'Contents', 'MacOS', 'monad-startup'),
    'utf8'
  );
  expect(launcher).toContain('/Applications/Monad.app/Contents/MacOS/monad');
  expect(launcher).toContain(join(dir, '.monad', 'logs', 'startup.log'));

  expect((await mod.setStartupSettings({ enabled: false })).enabled).toBe(false);
  expect(await mod.getStartupSettings()).toMatchObject({ enabled: false, supported: true });
  const retainedAppInfo = await readFile(join(dir, '.monad', 'startup', 'Monad.app', 'Contents', 'Info.plist'), 'utf8');
  expect(retainedAppInfo).toContain('<string>Monad</string>');
});

test('macOS dev startup setting uses Monad Dev identity', async () => {
  const mod = createStartupSettingsModule({
    platform: 'darwin',
    homeDir: dir,
    monadHome: join(dir, '.monad'),
    command: ['/opt/homebrew/bin/bun', join(dir, 'apps', 'monad', 'src', 'main.ts')],
    logPath: join(dir, '.monad', 'logs', 'startup.log')
  });

  expect(await mod.setStartupSettings({ enabled: true })).toMatchObject({ enabled: true, supported: true });

  const plist = await readFile(join(dir, 'Library', 'LaunchAgents', 'ai.monad.daemon.plist'), 'utf8');
  expect(plist).toContain('Monad Dev.app/Contents/MacOS/monad-startup');

  const appInfo = await readFile(join(dir, '.monad', 'startup', 'Monad Dev.app', 'Contents', 'Info.plist'), 'utf8');
  expect(appInfo).toContain('<string>Monad Dev</string>');
  expect(appInfo).toContain('<string>Monadix Labs, Inc.</string>');
});

test('macOS startup setting uses bundled login item registrar when available', async () => {
  let enabled = false;
  const calls: string[] = [];
  const mod = createStartupSettingsModule({
    platform: 'darwin',
    homeDir: dir,
    monadHome: join(dir, '.monad'),
    command: ['/Applications/Monad.app/Contents/MacOS/monad', 'daemon'],
    logPath: join(dir, '.monad', 'logs', 'startup.log'),
    macosLoginItemRegistrar: {
      async status() {
        calls.push('status');
        return enabled;
      },
      async register() {
        calls.push('register');
        enabled = true;
      },
      async unregister() {
        calls.push('unregister');
        enabled = false;
      }
    }
  });

  expect(await mod.getStartupSettings()).toMatchObject({ enabled: false, supported: true });
  expect(await mod.setStartupSettings({ enabled: true })).toMatchObject({ enabled: true, supported: true });
  await expect(access(join(dir, 'Library', 'LaunchAgents', 'ai.monad.daemon.plist'))).rejects.toThrow();
  expect(calls).toEqual(['status', 'register', 'status']);

  expect(await mod.setStartupSettings({ enabled: false })).toMatchObject({ enabled: false, supported: true });
  expect(calls).toEqual(['status', 'register', 'status', 'unregister', 'status']);
});

test('Windows startup setting writes and removes a branded startup shortcut', async () => {
  const appDataDir = join(dir, 'Redirected', 'Roaming');
  const shortcuts: Array<{ path: string; name: string; iconPath: string; command: string[] }> = [];
  const mod = createStartupSettingsModule({
    platform: 'win32',
    homeDir: dir,
    appDataDir,
    monadHome: join(dir, 'Monad Home'),
    command: ['C:\\Program Files\\Monad\\monad.exe', 'daemon'],
    logPath: join(dir, 'Monad Home', 'logs', 'startup.log'),
    writeWindowsShortcut: async (shortcut) => {
      shortcuts.push(shortcut);
      await writeFile(shortcut.path, 'shortcut');
    }
  });

  expect(await mod.setStartupSettings({ enabled: true })).toMatchObject({ enabled: true, supported: true });

  expect(shortcuts).toEqual([
    expect.objectContaining({
      path: join(appDataDir, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Monad.lnk'),
      name: 'Monad',
      command: ['C:\\Program Files\\Monad\\monad.exe', 'daemon']
    })
  ]);
  expect(shortcuts[0]?.iconPath).toContain('monad');

  expect((await mod.setStartupSettings({ enabled: false })).enabled).toBe(false);
});

test('startup setting recognizes and removes legacy startup files', async () => {
  const appDataDir = join(dir, 'AppData');
  const windowsStartupDir = join(appDataDir, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  await mkdir(windowsStartupDir, { recursive: true });
  await writeFile(join(windowsStartupDir, 'Monad.cmd'), '@echo off\r\n');

  const win = createStartupSettingsModule({
    platform: 'win32',
    homeDir: dir,
    appDataDir,
    monadHome: join(dir, 'Monad Home'),
    command: ['C:\\Program Files\\Monad\\monad.exe', 'daemon'],
    logPath: join(dir, 'Monad Home', 'logs', 'startup.log')
  });

  expect(await win.getStartupSettings()).toMatchObject({ enabled: true, supported: true });
  expect(await win.setStartupSettings({ enabled: false })).toMatchObject({ enabled: false, supported: true });
  await expect(access(join(windowsStartupDir, 'Monad.cmd'))).rejects.toThrow();

  const linuxHome = join(dir, 'linux-dev');
  const linuxAutostartDir = join(linuxHome, '.config', 'autostart');
  await mkdir(linuxAutostartDir, { recursive: true });
  await writeFile(join(linuxAutostartDir, 'monad.desktop'), '[Desktop Entry]\nName=Monad\n');

  const linux = createStartupSettingsModule({
    platform: 'linux',
    homeDir: linuxHome,
    monadHome: join(linuxHome, '.monad'),
    command: ['/usr/bin/bun', join(dir, 'apps', 'monad', 'src', 'main.ts')],
    logPath: join(linuxHome, '.monad', 'logs', 'startup.log')
  });

  expect(await linux.getStartupSettings()).toMatchObject({ enabled: true, supported: true });
  expect(await linux.setStartupSettings({ enabled: false })).toMatchObject({ enabled: false, supported: true });
  await expect(access(join(linuxAutostartDir, 'monad.desktop'))).rejects.toThrow();
});

test('startup setting reads external system changes and overwrites stale files', async () => {
  const home = join(dir, 'linux-sync');
  const monadHome = join(home, '.monad');
  const autostartDir = join(home, '.config', 'autostart');
  const desktopPath = join(autostartDir, 'monad.desktop');
  const mod = createStartupSettingsModule({
    platform: 'linux',
    homeDir: home,
    monadHome,
    command: ['/usr/local/bin/monad', 'daemon'],
    logPath: join(monadHome, 'logs', 'startup.log')
  });

  expect(await mod.getStartupSettings()).toMatchObject({ enabled: false, supported: true });

  await mkdir(autostartDir, { recursive: true });
  await writeFile(desktopPath, '[Desktop Entry]\nName=External Monad\n');
  expect(await mod.getStartupSettings()).toMatchObject({ enabled: true, supported: true });

  await mod.setStartupSettings({ enabled: true });
  const overwritten = await readFile(desktopPath, 'utf8');
  expect(overwritten).toContain('Name=Monad');
  expect(overwritten).not.toContain('External Monad');

  await rm(desktopPath);
  expect(await mod.getStartupSettings()).toMatchObject({ enabled: false, supported: true });
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

  const desktop = await readFile(join(dir, '.config', 'autostart', 'monad.desktop'), 'utf8');
  expect(desktop).toContain('Name=Monad');

  const devMod = createStartupSettingsModule({
    platform: 'linux',
    homeDir: join(dir, 'dev-home'),
    monadHome: join(dir, 'dev-home', '.monad'),
    command: ['/usr/bin/bun', join(dir, 'apps', 'monad', 'src', 'main.ts')],
    logPath: join(dir, 'dev-home', '.monad', 'logs', 'startup.log')
  });
  expect(await devMod.setStartupSettings({ enabled: true })).toMatchObject({ enabled: true, supported: true });
  const devDesktop = await readFile(join(dir, 'dev-home', '.config', 'autostart', 'monad-dev.desktop'), 'utf8');
  expect(devDesktop).toContain('Name=Monad Dev');

  expect((await mod.setStartupSettings({ enabled: false })).enabled).toBe(false);
});
