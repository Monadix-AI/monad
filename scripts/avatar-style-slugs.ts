import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export async function listAvatarStyleSlugs(root = resolve(import.meta.dir, '..')): Promise<string[]> {
  const stylesEntry = Bun.resolveSync('@dicebear/styles/adventurer.json', join(root, 'apps/monad'));
  const distDir = dirname(stylesEntry);

  const slugs = (await readdir(distDir))
    .filter((file) => file.endsWith('.min.json'))
    .map((file) => file.slice(0, -'.min.json'.length))
    .sort();

  if (slugs.length === 0) throw new Error('avatar styles: no styles found in @dicebear/styles');
  return slugs;
}
