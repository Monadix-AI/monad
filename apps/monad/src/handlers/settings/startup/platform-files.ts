import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export interface StartupIdentity {
  name: 'Monad' | 'Monad Dev';
  slug: 'monad' | 'monad-dev';
  developer: typeof DEVELOPER_NAME;
}

export interface WindowsStartupShortcut {
  path: string;
  name: string;
  iconPath: string;
  command: string[];
  monadHome: string;
  logPath: string;
}

export interface StartupFileOptions {
  monadHome: string;
  logPath: string;
  writeWindowsShortcut?: (shortcut: WindowsStartupShortcut) => Promise<void>;
}

export const MACOS_LABEL = 'ai.monad.daemon';
const DEVELOPER_NAME = 'Monadix Labs, Inc.';

export function startupIdentity(command: string[]): StartupIdentity {
  const isDev = command.some(
    (arg) => arg.endsWith('/apps/monad/src/main.ts') || arg.endsWith('\\apps\\monad\\src\\main.ts')
  );
  return {
    name: isDev ? 'Monad Dev' : 'Monad',
    slug: isDev ? 'monad-dev' : 'monad',
    developer: DEVELOPER_NAME
  };
}

export async function writeStartupFile(
  platform: NodeJS.Platform,
  target: { path: string; mode: number },
  identity: StartupIdentity,
  command: string[],
  options: StartupFileOptions
): Promise<void> {
  await mkdir(dirname(target.path), { recursive: true });
  if (platform === 'darwin') {
    const app = await writeMacosStartupApp(identity, command, options.monadHome, options.logPath);
    await writeFile(
      target.path,
      renderLaunchAgent([join(app, 'Contents', 'MacOS', 'monad-startup')], options.monadHome, options.logPath),
      {
        mode: target.mode
      }
    );
    return;
  }
  if (platform === 'win32') {
    await (options.writeWindowsShortcut ?? writeWindowsShortcut)({
      path: target.path,
      name: identity.name,
      iconPath: startupIconPath('win32', command),
      command,
      monadHome: options.monadHome,
      logPath: options.logPath
    });
    return;
  }
  await writeFile(target.path, renderXdgAutostart(identity, command, options.monadHome, options.logPath), {
    mode: target.mode
  });
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

async function writeMacosStartupApp(
  identity: StartupIdentity,
  command: string[],
  monadHome: string,
  logPath: string
): Promise<string> {
  const app = join(monadHome, 'startup', `${identity.name}.app`);
  const contents = join(app, 'Contents');
  const macos = join(contents, 'MacOS');
  const resources = join(contents, 'Resources');
  await mkdir(macos, { recursive: true });
  await mkdir(resources, { recursive: true });
  const iconFile = await installMacosIcon(startupIconPath('darwin', command), resources);
  await writeFile(join(contents, 'Info.plist'), renderMacosInfoPlist(identity, iconFile), { mode: 0o644 });
  const launcher = join(macos, 'monad-startup');
  await writeFile(launcher, renderPosixLauncher(command, monadHome, logPath), { mode: 0o755 });
  await chmod(launcher, 0o755);
  return app;
}

function renderMacosInfoPlist(identity: StartupIdentity, iconFile: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>monad-startup</string>
  <key>CFBundleIconFile</key>
  <string>${escapeXml(iconFile)}</string>
  <key>CFBundleIdentifier</key>
  <string>ai.monad.${identity.slug}.startup</string>
  <key>CFBundleName</key>
  <string>${identity.name}</string>
  <key>CFBundleDisplayName</key>
  <string>${identity.name}</string>
  <key>NSHumanReadableCopyright</key>
  <string>${identity.developer}</string>
</dict>
</plist>
`;
}

async function installMacosIcon(source: string, resources: string): Promise<string> {
  if (!existsSync(source)) return 'MonadIcon';
  if (process.platform === 'darwin') {
    const tmp = await mkdtemp(join(tmpdir(), 'monad-startup-icon-'));
    const iconset = join(tmp, 'MonadIcon.iconset');
    await mkdir(iconset, { recursive: true });
    try {
      for (const size of [16, 32, 128, 256, 512]) {
        const retina = size * 2;
        await runQuiet([
          'sips',
          '-s',
          'format',
          'png',
          '-z',
          String(size),
          String(size),
          source,
          '--out',
          join(iconset, `icon_${size}x${size}.png`)
        ]);
        await runQuiet([
          'sips',
          '-s',
          'format',
          'png',
          '-z',
          String(retina),
          String(retina),
          source,
          '--out',
          join(iconset, `icon_${size}x${size}@2x.png`)
        ]);
      }
      await runQuiet(['iconutil', '-c', 'icns', iconset, '-o', join(resources, 'MonadIcon.icns')]);
      return 'MonadIcon';
    } catch {
      await copyFile(source, join(resources, 'MonadIcon.svg'));
      return 'MonadIcon.svg';
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
  await copyFile(source, join(resources, 'MonadIcon.svg'));
  return 'MonadIcon.svg';
}

async function runQuiet(argv: string[]): Promise<void> {
  const proc = Bun.spawn(argv, { stdout: 'ignore', stderr: 'ignore' });
  if ((await proc.exited) !== 0) throw new Error(`${argv[0]} failed`);
}

function renderPosixLauncher(command: string[], monadHome: string, logPath: string): string {
  return `#!/bin/sh
export MONAD_HOME=${quoteShell(monadHome)}
exec ${command.map(quoteShell).join(' ')} >> ${quoteShell(logPath)} 2>&1
`;
}

async function writeWindowsShortcut(shortcut: WindowsStartupShortcut): Promise<void> {
  const script = renderWindowsShortcutScript(shortcut);
  const proc = Bun.spawn(
    ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      stdout: 'ignore',
      stderr: 'pipe'
    }
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const error = await new Response(proc.stderr).text();
    throw new Error(`Failed to create Windows startup shortcut: ${error || `exit ${exitCode}`}`);
  }
}

function renderWindowsShortcutScript(shortcut: WindowsStartupShortcut): string {
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

function renderXdgAutostart(identity: StartupIdentity, command: string[], monadHome: string, logPath: string): string {
  const shellCommand = `MONAD_HOME=${quoteShell(monadHome)} exec ${command.map(quoteShell).join(' ')} >> ${quoteShell(logPath)} 2>&1`;
  return `[Desktop Entry]
Type=Application
Name=${identity.name}
Comment=Start the Monad daemon at login
Exec=/bin/sh -lc ${quoteDesktop(shellCommand)}
Icon=${startupIconPath('linux', command)}
Terminal=false
X-GNOME-Autostart-enabled=true
`;
}

function startupIconPath(platform: NodeJS.Platform, command: string[]): string {
  const filename = platform === 'win32' ? 'favicon.ico' : 'monad-icon-vector-solid.svg';
  const candidates = assetCandidates(command, filename);
  return candidates.find((path) => existsSync(path)) ?? 'monad';
}

function assetCandidates(command: string[], filename: string): string[] {
  const candidates: string[] = [];
  const script = command.find(
    (arg) => arg.endsWith('/apps/monad/src/main.ts') || arg.endsWith('\\apps\\monad\\src\\main.ts')
  );
  if (script) {
    const marker = join('apps', 'monad', 'src', 'main.ts');
    candidates.push(join(script.slice(0, script.length - marker.length), 'apps', 'web', 'public', filename));
  }
  const executable = command[0];
  if (executable) {
    candidates.push(join(dirname(executable), '..', 'assets', filename));
    if (filename === 'favicon.ico' && basename(executable).toLowerCase().includes('monad')) candidates.push(executable);
  }
  candidates.push(join(process.cwd(), 'apps', 'web', 'public', filename), join(process.cwd(), 'assets', filename));
  return candidates;
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

function powerShellString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function quoteDesktop(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}
