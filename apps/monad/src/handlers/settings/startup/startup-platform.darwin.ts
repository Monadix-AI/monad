import type { StartupPlatform, StartupPlatformModule, StartupRegistrar } from './startup-platform-contract.ts';

import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { escapeXml, quoteShell, startupIconPath } from './startup-platform-common.ts';

const MACOS_LABEL = 'ai.monad.daemon';

const platform: StartupPlatform = {
  platform: 'darwin',
  target({ homeDir }) {
    return { path: join(homeDir, 'Library', 'LaunchAgents', `${MACOS_LABEL}.plist`), mode: 0o644 };
  },
  legacyTargets() {
    return [];
  },
  registrar(context) {
    return context.macosLoginItemRegistrar ?? resolveRegistrar(context.command);
  },
  async write(target, context) {
    await mkdir(dirname(target.path), { recursive: true });
    const bundleIdentifier = `ai.monad.${context.identity.slug}.startup`;
    const app = await writeStartupApp(context, bundleIdentifier);
    await writeFile(
      target.path,
      renderLaunchAgent(
        [join(app, 'Contents', 'MacOS', 'monad-startup')],
        bundleIdentifier,
        context.monadHome,
        context.logPath
      ),
      { mode: target.mode }
    );
  }
};

export const startupPlatformModule: StartupPlatformModule = {
  current: platform,
  forPlatform(value) {
    return value === 'darwin' ? platform : null;
  }
};

function resolveRegistrar(command: string[]): StartupRegistrar | null {
  const registrar = registrarCandidates(command).find((path) => existsSync(path));
  return registrar ? spawnRegistrar(registrar) : null;
}

function registrarCandidates(command: string[]): string[] {
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

function spawnRegistrar(registrar: string): StartupRegistrar {
  const run = async (action: 'status' | 'register' | 'unregister') => {
    const proc = Bun.spawn([registrar, action], { stdout: 'ignore', stderr: 'ignore' });
    return proc.exited;
  };
  return {
    async status() {
      const code = await run('status');
      if (code === 0) return true;
      if (code === 2) return false;
      throw new Error(`macOS login item status failed with exit ${code}`);
    },
    async register() {
      const code = await run('register');
      if (code !== 0) throw new Error(`macOS login item register failed with exit ${code}`);
    },
    async unregister() {
      const code = await run('unregister');
      if (code !== 0) throw new Error(`macOS login item unregister failed with exit ${code}`);
    }
  };
}

async function writeStartupApp(
  context: Parameters<StartupPlatform['write']>[1],
  bundleIdentifier: string
): Promise<string> {
  const app = join(context.monadHome, 'startup', `${context.identity.name}.app`);
  const contents = join(app, 'Contents');
  const macos = join(contents, 'MacOS');
  const resources = join(contents, 'Resources');
  await mkdir(macos, { recursive: true });
  await mkdir(resources, { recursive: true });
  const iconFile = await installIcon(startupIconPath('darwin', context.command), resources);
  await writeFile(join(contents, 'Info.plist'), renderInfoPlist(context, bundleIdentifier, iconFile), { mode: 0o644 });
  const launcher = join(macos, 'monad-startup');
  await writeFile(launcher, renderLauncher(context), { mode: 0o755 });
  await chmod(launcher, 0o755);
  return app;
}

function renderLaunchAgent(command: string[], bundleIdentifier: string, monadHome: string, logPath: string): string {
  const args = command.map((arg) => `    <string>${escapeXml(arg)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>Label</key><string>${MACOS_LABEL}</string><key>ProgramArguments</key><array>
${args}
</array><key>AssociatedBundleIdentifiers</key><array><string>${escapeXml(bundleIdentifier)}</string></array><key>EnvironmentVariables</key><dict><key>MONAD_HOME</key><string>${escapeXml(monadHome)}</string></dict><key>RunAtLoad</key><true/><key>StandardOutPath</key><string>${escapeXml(logPath)}</string><key>StandardErrorPath</key><string>${escapeXml(logPath)}</string></dict></plist>
`;
}

function renderInfoPlist(
  context: Parameters<StartupPlatform['write']>[1],
  bundleIdentifier: string,
  iconFile: string
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>monad-startup</string><key>CFBundleIconFile</key><string>${escapeXml(iconFile)}</string><key>CFBundleIdentifier</key><string>${escapeXml(bundleIdentifier)}</string><key>CFBundleName</key><string>${context.identity.name}</string><key>CFBundleDisplayName</key><string>${context.identity.name}</string><key>NSHumanReadableCopyright</key><string>${context.identity.developer}</string></dict></plist>
`;
}

function renderLauncher(context: Parameters<StartupPlatform['write']>[1]): string {
  return `#!/bin/sh
export MONAD_HOME=${quoteShell(context.monadHome)}
exec ${context.command.map(quoteShell).join(' ')} >> ${quoteShell(context.logPath)} 2>&1
`;
}

async function installIcon(source: string, resources: string): Promise<string> {
  if (!existsSync(source)) return 'MonadIcon';
  const tmp = await mkdtemp(join(tmpdir(), 'monad-startup-icon-'));
  const iconset = join(tmp, 'MonadIcon.iconset');
  await mkdir(iconset, { recursive: true });
  try {
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const pixels = size * scale;
        const suffix = scale === 2 ? '@2x' : '';
        await runQuiet([
          'sips',
          '-s',
          'format',
          'png',
          '-z',
          String(pixels),
          String(pixels),
          source,
          '--out',
          join(iconset, `icon_${size}x${size}${suffix}.png`)
        ]);
      }
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

async function runQuiet(argv: string[]): Promise<void> {
  const proc = Bun.spawn(argv, { stdout: 'ignore', stderr: 'ignore' });
  if ((await proc.exited) !== 0) throw new Error(`${argv[0]} failed`);
}
