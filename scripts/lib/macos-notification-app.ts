import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MACOS_NOTIFICATION_APP_RELATIVE_PATH = join('helpers', 'Monad.app');

export function macOSNotificationTarget(arch: 'arm64' | 'x64'): string {
  return `${arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.0`;
}

export function renderMacOSNotificationInfoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>monad-notifier</string>
  <key>CFBundleIdentifier</key>
  <string>ai.monad.notifier</string>
  <key>CFBundleName</key>
  <string>Monad</string>
  <key>CFBundleDisplayName</key>
  <string>Monad</string>
  <key>CFBundleIconFile</key>
  <string>MonadIcon</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHumanReadableCopyright</key>
  <string>Copyright © Monadix Labs, Inc.</string>
</dict>
</plist>
`;
}

export async function buildMacOSNotificationApp(options: {
  root: string;
  artifactDir: string;
  arch: 'arm64' | 'x64';
}): Promise<string> {
  const appPath = join(options.artifactDir, MACOS_NOTIFICATION_APP_RELATIVE_PATH);
  const contents = join(appPath, 'Contents');
  const executableDir = join(contents, 'MacOS');
  const resourcesDir = join(contents, 'Resources');
  const executable = join(executableDir, 'monad-notifier');
  mkdirSync(executableDir, { recursive: true });
  mkdirSync(resourcesDir, { recursive: true });
  writeFileSync(join(contents, 'Info.plist'), renderMacOSNotificationInfoPlist());

  await run([
    'xcrun',
    'swiftc',
    '-O',
    '-target',
    macOSNotificationTarget(options.arch),
    '-framework',
    'AppKit',
    '-framework',
    'UserNotifications',
    '-o',
    executable,
    join(options.root, 'apps/monad/native/macos-notification-app/main.swift')
  ]);

  await buildIcon(join(options.root, 'apps/web/public/monad-icon-1024.png'), resourcesDir);
  await run(['codesign', '--force', '--sign', '-', '--timestamp=none', appPath]);
  return appPath;
}

async function buildIcon(source: string, resourcesDir: string): Promise<void> {
  const iconset = join(resourcesDir, 'MonadIcon.iconset');
  mkdirSync(iconset, { recursive: true });
  try {
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const pixels = size * scale;
        const suffix = scale === 2 ? '@2x' : '';
        await run([
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
    writeIcns(iconset, join(resourcesDir, 'MonadIcon.icns'));
  } finally {
    rmSync(iconset, { recursive: true, force: true });
  }
}

function writeIcns(iconset: string, output: string): void {
  const entries = [
    ['icp4', 'icon_16x16.png'],
    ['icp5', 'icon_32x32.png'],
    ['icp6', 'icon_32x32@2x.png'],
    ['ic07', 'icon_128x128.png'],
    ['ic08', 'icon_256x256.png'],
    ['ic09', 'icon_512x512.png'],
    ['ic10', 'icon_512x512@2x.png']
  ] as const;
  const chunks = entries.map(([type, filename]) => {
    const data = readFileSync(join(iconset, filename));
    const chunk = Buffer.alloc(8 + data.length);
    chunk.write(type, 0, 4, 'ascii');
    chunk.writeUInt32BE(chunk.length, 4);
    data.copy(chunk, 8);
    return chunk;
  });
  const totalLength = 8 + chunks.reduce((total, chunk) => total + chunk.length, 0);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(totalLength, 4);
  writeFileSync(output, Buffer.concat([header, ...chunks], totalLength));
}

async function run(argv: string[]): Promise<void> {
  const proc = Bun.spawn(argv, { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`${argv[0]} failed with exit ${exitCode}: ${stderr.trim()}`);
}
