import type { SetStartupSettingsRequest, StartupSettings } from '@monad/protocol';
import type { StartupRegistrar } from './startup-platform-contract.ts';

import { access, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

import { startupPlatformModule } from './startup-platform.ts';
import { startupIdentity, type WindowsStartupShortcut } from './startup-platform-common.ts';

export interface StartupSettingsOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  appDataDir?: string;
  monadHome: string;
  command?: string[];
  logPath: string;
  macosLoginItemRegistrar?: StartupRegistrar;
  writeWindowsShortcut?: (shortcut: WindowsStartupShortcut) => Promise<void>;
}

export function createStartupSettingsModule(options: StartupSettingsOptions) {
  const platformName = options.platform ?? process.platform;
  const platform = startupPlatformModule.forPlatform(platformName);
  const command = options.command ?? defaultDaemonCommand();
  const context = {
    homeDir: options.homeDir ?? homedir(),
    appDataDir: options.appDataDir ?? process.env.APPDATA,
    identity: startupIdentity(command),
    command,
    monadHome: options.monadHome,
    logPath: options.logPath,
    macosLoginItemRegistrar: options.macosLoginItemRegistrar,
    writeWindowsShortcut: options.writeWindowsShortcut
  };
  const target = platform?.target(context) ?? null;
  const legacyTargets = platform ? [...platform.legacyTargets(context)] : [];
  const registrar = platform?.registrar(context) ?? null;

  async function getStartupSettings(): Promise<StartupSettings> {
    if (!platform || !target) return unsupported(platformName);
    return {
      enabled: registrar ? await registrar.status() : await existsAny([target.path, ...legacyTargets]),
      supported: true,
      platform: platformName,
      command
    };
  }

  async function setStartupSettings(req: SetStartupSettingsRequest): Promise<StartupSettings> {
    if (!platform || !target) return unsupported(platformName);
    if (registrar) {
      if (req.enabled) await registrar.register();
      else await registrar.unregister();
      await rm(target.path, { force: true });
      await removePaths(legacyTargets);
      return getStartupSettings();
    }
    if (req.enabled) {
      await mkdir(dirname(options.logPath), { recursive: true });
      await platform.write(target, context);
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
  for (const path of paths) if (await exists(path)) return true;
  return false;
}

async function removePaths(paths: string[]): Promise<void> {
  await Promise.all(paths.map((path) => rm(path, { force: true })));
}

function defaultDaemonCommand(): string[] {
  const argv = process.argv.filter((arg) => arg !== '--start-relay');
  const script = argv[1] ?? '';
  if (script.endsWith('/apps/monad/src/main.ts') || script.endsWith('\\apps\\monad\\src\\main.ts')) {
    return [process.execPath, script];
  }
  return [process.execPath, 'daemon'];
}
