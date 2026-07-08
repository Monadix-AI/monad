import type { SetStartupSettingsRequest, StartupSettings } from '@monad/protocol';
import type { StartupIdentity, WindowsStartupShortcut } from '#/handlers/settings/startup/platform-files.ts';

import { existsSync } from 'node:fs';
import { access, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { MACOS_LABEL, startupIdentity, writeStartupFile } from '#/handlers/settings/startup/platform-files.ts';

export interface StartupSettingsOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  appDataDir?: string;
  monadHome: string;
  command?: string[];
  logPath: string;
  macosLoginItemRegistrar?: MacosLoginItemRegistrar;
  writeWindowsShortcut?: (shortcut: WindowsStartupShortcut) => Promise<void>;
}

export interface MacosLoginItemRegistrar {
  status(): Promise<boolean>;
  register(): Promise<void>;
  unregister(): Promise<void>;
}

export function createStartupSettingsModule(options: StartupSettingsOptions) {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? homedir();
  const command = options.command ?? defaultDaemonCommand();
  const identity = startupIdentity(command);
  const target = startupTarget(platform, homeDir, identity, options.appDataDir ?? process.env.APPDATA);
  const legacyTargets = legacyStartupTargets(platform, homeDir, identity, options.appDataDir ?? process.env.APPDATA);
  const macosLoginItemRegistrar =
    platform === 'darwin' ? (options.macosLoginItemRegistrar ?? resolveMacosLoginItemRegistrar(command)) : null;

  async function getStartupSettings(): Promise<StartupSettings> {
    if (!target) return unsupported(platform);
    return {
      enabled: macosLoginItemRegistrar
        ? await macosLoginItemRegistrar.status()
        : await existsAny([target.path, ...legacyTargets]),
      supported: true,
      platform,
      command
    };
  }

  async function setStartupSettings(req: SetStartupSettingsRequest): Promise<StartupSettings> {
    if (!target) return unsupported(platform);
    if (macosLoginItemRegistrar) {
      if (req.enabled) await macosLoginItemRegistrar.register();
      else await macosLoginItemRegistrar.unregister();
      await rm(target.path, { force: true });
      await removePaths(legacyTargets);
      return getStartupSettings();
    }
    if (req.enabled) {
      await mkdir(dirname(options.logPath), { recursive: true });
      await writeStartupFile(platform, target, identity, command, options);
      await removePaths(legacyTargets);
    } else {
      await rm(target.path, { force: true });
      await removePaths(legacyTargets);
    }
    return getStartupSettings();
  }

  return { getStartupSettings, setStartupSettings };
}

function unsupported(platform: string): StartupSettings {
  return {
    enabled: false,
    supported: false,
    platform,
    reason: `Startup settings are not supported on ${platform}.`
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function existsAny(paths: string[]): Promise<boolean> {
  for (const path of paths) {
    if (await exists(path)) return true;
  }
  return false;
}

async function removePaths(paths: string[]): Promise<void> {
  await Promise.all(paths.map((path) => rm(path, { force: true })));
}

function startupTarget(
  platform: NodeJS.Platform,
  homeDir: string,
  identity: StartupIdentity,
  appDataDir?: string
): { path: string; mode: number } | null {
  if (platform === 'darwin')
    return { path: join(homeDir, 'Library', 'LaunchAgents', `${MACOS_LABEL}.plist`), mode: 0o644 };
  if (platform === 'win32') {
    const roaming = appDataDir || join(homeDir, 'AppData', 'Roaming');
    return {
      path: join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `${identity.name}.lnk`),
      mode: 0o644
    };
  }
  if (platform === 'linux')
    return { path: join(homeDir, '.config', 'autostart', `${identity.slug}.desktop`), mode: 0o644 };
  return null;
}

function legacyStartupTargets(
  platform: NodeJS.Platform,
  homeDir: string,
  identity: StartupIdentity,
  appDataDir?: string
): string[] {
  if (platform === 'win32') {
    const roaming = appDataDir || join(homeDir, 'AppData', 'Roaming');
    return [join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Monad.cmd')];
  }
  if (platform === 'linux' && identity.slug === 'monad-dev')
    return [join(homeDir, '.config', 'autostart', 'monad.desktop')];
  return [];
}

function defaultDaemonCommand(): string[] {
  const argv = process.argv.filter((arg) => arg !== '--start-relay');
  const script = argv[1] ?? '';
  if (script.endsWith('/apps/monad/src/main.ts') || script.endsWith('\\apps\\monad\\src\\main.ts')) {
    return [process.execPath, script];
  }
  return [process.execPath, 'daemon'];
}

function resolveMacosLoginItemRegistrar(command: string[]): MacosLoginItemRegistrar | null {
  const registrar = macosLoginItemRegistrarCandidates(command).find((path) => existsSync(path));
  return registrar ? spawnMacosLoginItemRegistrar(registrar) : null;
}

function macosLoginItemRegistrarCandidates(command: string[]): string[] {
  const executable = command[0];
  if (!executable) return [];
  const candidates = [join(dirname(executable), 'monad-login-item')];
  const marker = '.app/Contents/MacOS/';
  const markerIndex = executable.indexOf(marker);
  if (markerIndex !== -1) {
    const app = executable.slice(0, markerIndex + '.app'.length);
    candidates.push(
      join(app, 'Contents', 'MacOS', 'monad-login-item'),
      join(app, 'Contents', 'Library', 'LoginItems', 'Monad Login Item.app', 'Contents', 'MacOS', 'monad-login-item')
    );
  }
  return candidates;
}

function spawnMacosLoginItemRegistrar(registrar: string): MacosLoginItemRegistrar {
  return {
    async status() {
      const exitCode = await runRegistrar(registrar, 'status');
      if (exitCode === 0) return true;
      if (exitCode === 2) return false;
      throw new Error(`macOS login item status failed with exit ${exitCode}`);
    },
    async register() {
      const exitCode = await runRegistrar(registrar, 'register');
      if (exitCode !== 0) throw new Error(`macOS login item register failed with exit ${exitCode}`);
    },
    async unregister() {
      const exitCode = await runRegistrar(registrar, 'unregister');
      if (exitCode !== 0) throw new Error(`macOS login item unregister failed with exit ${exitCode}`);
    }
  };
}

async function runRegistrar(registrar: string, action: 'status' | 'register' | 'unregister'): Promise<number> {
  const proc = Bun.spawn([registrar, action], { stdout: 'ignore', stderr: 'ignore' });
  return proc.exited;
}
