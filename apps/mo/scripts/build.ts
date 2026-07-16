// Build the native Mo binary for the host OS. The single `process.platform` branch
// lives HERE (mirroring packages/environment/src/open-url.ts) — each OS has its own native
// shell under native/<os>/, all implementing the same behaviour against the daemon's
// REST contract. No feature code branches on platform.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function builderFor(platform: NodeJS.Platform): { dir: string; cmd: string[] } {
  switch (platform) {
    case 'darwin':
      return { dir: join(root, 'native/macos'), cmd: ['bash', 'build.sh'] };
    case 'win32':
      return { dir: join(root, 'native/windows'), cmd: ['cmd', '/c', 'build.bat'] };
    default:
      return { dir: join(root, 'native/linux'), cmd: ['bash', 'build.sh'] };
  }
}

const { dir, cmd } = builderFor(process.platform);
const [bin, ...args] = cmd;
const res = spawnSync(bin, args, { cwd: dir, stdio: 'inherit' });
if (res.status !== 0) {
  process.stderr.write(`mo: native build failed for ${process.platform} (see ${dir})\n`);
  process.exit(res.status ?? 1);
}
