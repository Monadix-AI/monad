import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const INSTALLERS = new Set(['install.ps1', 'install.sh', 'monad-installer.ps1', 'monad-installer.sh']);
const POWER_PACK = /^monad-power-pack\.atom-pack\.zip(?:\.sha256)?$/;
const PLATFORM_ARCHIVE = /^monad-(.+)\.(tar\.gz|zip)$/;
const PLATFORM_ARCHIVE_CHECKSUM = /^monad-(.+)\.(tar\.gz|zip)\.sha256$/;
const PLATFORM_UPDATER = /^monad-(.+)-update$/;

export function isPublicReleaseAsset(name: string): boolean {
  return (
    INSTALLERS.has(name) ||
    POWER_PACK.test(name) ||
    PLATFORM_ARCHIVE.test(name) ||
    PLATFORM_ARCHIVE_CHECKSUM.test(name) ||
    PLATFORM_UPDATER.test(name)
  );
}

export async function stagePublicReleaseAssets(sourceDir: string, destinationDir: string): Promise<string[]> {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && isPublicReleaseAsset(entry.name))
    .map((entry) => entry.name)
    .sort();

  validatePublicReleaseAssets(names);
  await rm(destinationDir, { force: true, recursive: true });
  await mkdir(destinationDir, { recursive: true });
  await Promise.all(names.map((name) => copyFile(join(sourceDir, name), join(destinationDir, name))));
  return names;
}

export function validatePublicReleaseAssets(names: string[]): void {
  const assets = new Set(names);
  const required = [...INSTALLERS, 'monad-power-pack.atom-pack.zip', 'monad-power-pack.atom-pack.zip.sha256'];
  const missing = required.filter((name) => !assets.has(name));
  if (missing.length > 0) throw new Error(`missing required public release assets: ${missing.join(', ')}`);

  const updaterTargets = names.flatMap((name) => name.match(PLATFORM_UPDATER)?.[1] ?? []);
  if (updaterTargets.length === 0) throw new Error('no platform updater assets found');
  for (const target of updaterTargets) {
    const archive = names.find((name) => name.match(PLATFORM_ARCHIVE)?.[1] === target);
    if (!archive) throw new Error(`missing platform archive for updater target ${target}`);
    if (!assets.has(`${archive}.sha256`)) throw new Error(`missing checksum for platform archive ${archive}`);
  }

  const archiveTargets = names.flatMap((name) =>
    POWER_PACK.test(name) ? [] : (name.match(PLATFORM_ARCHIVE)?.[1] ?? [])
  );
  const orphaned = archiveTargets.filter((target) => !assets.has(`monad-${target}-update`));
  if (orphaned.length > 0) throw new Error(`platform archives without updater assets: ${orphaned.join(', ')}`);
}
