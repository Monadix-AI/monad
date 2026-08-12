import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const INSTALLERS = new Set(['install.ps1', 'install.sh']);
const POWER_PACK = 'monad-power-pack.atom-pack.zip';
const PLATFORM_ARCHIVE = /^monad-(.+)\.(tar\.gz|zip)$/;

export function isPublicReleaseAsset(name: string): boolean {
  return INSTALLERS.has(name) || name === POWER_PACK || PLATFORM_ARCHIVE.test(name);
}

export function isPlatformReleaseArchive(name: string): boolean {
  return PLATFORM_ARCHIVE.test(name) && name !== POWER_PACK;
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
  const required = [...INSTALLERS, POWER_PACK];
  const missing = required.filter((name) => !assets.has(name));
  if (missing.length > 0) throw new Error(`missing required public release assets: ${missing.join(', ')}`);

  if (!names.some((name) => isPlatformReleaseArchive(name))) {
    throw new Error('no platform release archives found');
  }
}
