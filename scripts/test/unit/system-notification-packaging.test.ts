import { expect, test } from 'bun:test';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');

test('release packaging carries notification helpers and the cross-platform PNG icon', async () => {
  const release = await Bun.file(join(root, 'scripts/build-release.ts')).text();
  const adapter = await Bun.file(join(root, 'scripts/build-dist.ts')).text();
  const dist = await Bun.file(join(root, 'distribution/dist.toml')).text();

  expect(release).toContain("'monad-icon-1024.png'");
  expect(release).toContain("'monad-shortcut-aumid.exe'");
  expect(release).toContain('buildMacOSNotificationApp');
  expect(adapter).toContain("['bin', 'assets', 'helpers']");
  expect(dist).toContain('include = ["out/assets", "out/helpers"]');
  expect(dist).toContain('"monad-sandbox-appcontainer"');
  expect(dist).toContain('"monad-shortcut-aumid"');
});
