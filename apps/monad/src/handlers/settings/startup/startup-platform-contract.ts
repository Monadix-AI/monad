import type { StartupIdentity, WindowsStartupShortcut } from './startup-platform-common.ts';

interface StartupTarget {
  path: string;
  mode: number;
}

export interface StartupRegistrar {
  status(): Promise<boolean>;
  register(): Promise<void>;
  unregister(): Promise<void>;
}

interface StartupPlatformContext {
  homeDir: string;
  appDataDir?: string;
  identity: StartupIdentity;
  command: string[];
  monadHome: string;
  logPath: string;
  macosLoginItemRegistrar?: StartupRegistrar;
  writeWindowsShortcut?: (shortcut: WindowsStartupShortcut) => Promise<void>;
}

export interface StartupPlatform {
  platform: 'darwin' | 'linux' | 'win32';
  target(context: StartupPlatformContext): StartupTarget;
  legacyTargets(context: StartupPlatformContext): readonly string[];
  registrar(context: StartupPlatformContext): StartupRegistrar | null;
  write(target: StartupTarget, context: StartupPlatformContext): Promise<void>;
}

export interface StartupPlatformModule {
  current: StartupPlatform;
  forPlatform(platform: NodeJS.Platform): StartupPlatform | null;
}
