import type { StartupPlatform, StartupPlatformModule } from './startup-platform-contract.ts';

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  DEVELOPER_NAME,
  escapeCmdValue,
  powerShellString,
  quoteWindowsArg,
  startupIconPath,
  type WindowsStartupShortcut
} from './startup-platform-common.ts';

const platform: StartupPlatform = {
  platform: 'win32',
  target({ homeDir, appDataDir, identity }) {
    const roaming = appDataDir || join(homeDir, 'AppData', 'Roaming');
    return {
      path: join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `${identity.name}.lnk`),
      mode: 0o644
    };
  },
  legacyTargets({ homeDir, appDataDir }) {
    const roaming = appDataDir || join(homeDir, 'AppData', 'Roaming');
    return [join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Monad.cmd')];
  },
  registrar() {
    return null;
  },
  async write(target, context) {
    await mkdir(dirname(target.path), { recursive: true });
    await (context.writeWindowsShortcut ?? writeShortcut)({
      path: target.path,
      name: context.identity.name,
      iconPath: startupIconPath('win32', context.command),
      command: context.command,
      monadHome: context.monadHome,
      logPath: context.logPath
    });
  }
};

export const startupPlatformModule: StartupPlatformModule = {
  current: platform,
  forPlatform(value) {
    return value === 'win32' ? platform : null;
  }
};

async function writeShortcut(shortcut: WindowsStartupShortcut): Promise<void> {
  const proc = Bun.spawn(
    [
      'powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      renderScript(shortcut)
    ],
    { stdout: 'ignore', stderr: 'pipe' }
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const error = await new Response(proc.stderr).text();
    throw new Error(`Failed to create Windows startup shortcut: ${error || `exit ${exitCode}`}`);
  }
}

function renderScript(shortcut: WindowsStartupShortcut): string {
  const commandLine = `set "MONAD_HOME=${escapeCmdValue(shortcut.monadHome)}" && ${shortcut.command.map(quoteWindowsArg).join(' ')} >> "${escapeCmdValue(shortcut.logPath)}" 2>&1`;
  return `$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut(${powerShellString(shortcut.path)})
$shortcut.TargetPath = "$env:ComSpec"
$shortcut.Arguments = ${powerShellString(`/d /c "${commandLine}"`)}
$shortcut.WorkingDirectory = ${powerShellString(dirname(shortcut.command[0] ?? shortcut.path))}
$shortcut.IconLocation = ${powerShellString(shortcut.iconPath)}
$shortcut.Description = ${powerShellString(`${shortcut.name} daemon (${DEVELOPER_NAME})`)}
$shortcut.Save()
`;
}
