import type { SetStartupSettingsRequest, StartupSettings } from '@monad/protocol';

import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface StartupSettingsOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  appDataDir?: string;
  monadHome: string;
  command?: string[];
  logPath: string;
}

const MACOS_LABEL = 'ai.monad.daemon';

export function createStartupSettingsModule(options: StartupSettingsOptions) {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? homedir();
  const command = options.command ?? defaultDaemonCommand();
  const target = startupTarget(platform, homeDir, options.appDataDir ?? process.env.APPDATA);

  async function getStartupSettings(): Promise<StartupSettings> {
    if (!target) return unsupported(platform);
    return {
      enabled: await exists(target.path),
      supported: true,
      platform,
      command
    };
  }

  async function setStartupSettings(req: SetStartupSettingsRequest): Promise<StartupSettings> {
    if (!target) return unsupported(platform);
    if (req.enabled) {
      await mkdir(dirname(target.path), { recursive: true });
      await mkdir(dirname(options.logPath), { recursive: true });
      await writeFile(target.path, renderStartupFile(platform, command, options.monadHome, options.logPath), {
        mode: target.mode
      });
    } else {
      await rm(target.path, { force: true });
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

function startupTarget(
  platform: NodeJS.Platform,
  homeDir: string,
  appDataDir?: string
): { path: string; mode: number } | null {
  if (platform === 'darwin')
    return { path: join(homeDir, 'Library', 'LaunchAgents', `${MACOS_LABEL}.plist`), mode: 0o644 };
  if (platform === 'win32') {
    const roaming = appDataDir || join(homeDir, 'AppData', 'Roaming');
    return {
      path: join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Monad.cmd'),
      mode: 0o644
    };
  }
  if (platform === 'linux') return { path: join(homeDir, '.config', 'autostart', 'monad.desktop'), mode: 0o644 };
  return null;
}

function defaultDaemonCommand(): string[] {
  const argv = process.argv.filter((arg) => arg !== '--start-relay');
  const script = argv[1] ?? '';
  if (script.endsWith('/apps/monad/src/main.ts') || script.endsWith('\\apps\\monad\\src\\main.ts')) {
    return [process.execPath, script];
  }
  return [process.execPath, 'daemon'];
}

function renderStartupFile(platform: NodeJS.Platform, command: string[], monadHome: string, logPath: string): string {
  if (platform === 'darwin') return renderLaunchAgent(command, monadHome, logPath);
  if (platform === 'win32') return renderWindowsStartup(command, monadHome, logPath);
  return renderXdgAutostart(command, monadHome, logPath);
}

function renderLaunchAgent(command: string[], monadHome: string, logPath: string): string {
  const args = command.map((arg) => `    <string>${escapeXml(arg)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MACOS_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MONAD_HOME</key>
    <string>${escapeXml(monadHome)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
</dict>
</plist>
`;
}

function renderWindowsStartup(command: string[], monadHome: string, logPath: string): string {
  const commandLine = `${command.map(quoteWindowsArg).join(' ')} >> "${escapeCmdValue(logPath)}" 2>&1`;
  return `@echo off\r
set "MONAD_HOME=${escapeCmdValue(monadHome)}"\r
start "" /min cmd /c "${escapeCmdValue(commandLine)}"\r
`;
}

function renderXdgAutostart(command: string[], monadHome: string, logPath: string): string {
  const shellCommand = `MONAD_HOME=${quoteShell(monadHome)} exec ${command.map(quoteShell).join(' ')} >> ${quoteShell(logPath)} 2>&1`;
  return `[Desktop Entry]
Type=Application
Name=Monad
Comment=Start the Monad daemon at login
Exec=/bin/sh -lc ${quoteDesktop(shellCommand)}
Terminal=false
X-GNOME-Autostart-enabled=true
`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function escapeCmdValue(value: string): string {
  return value.replaceAll('"', '""');
}

function quoteWindowsArg(value: string): string {
  return `"${escapeCmdValue(value)}"`;
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function quoteDesktop(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}
