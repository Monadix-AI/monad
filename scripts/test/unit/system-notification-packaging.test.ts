import { expect, test } from 'bun:test';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');

test('Windows installer assigns the AUMID used by desktop toasts', async () => {
  const installer = await Bun.file(join(root, 'scripts/install.ps1')).text();
  const helper = await Bun.file(join(root, 'apps/monad/native/windows-shortcut-aumid/main.c')).text();

  expect(installer).toContain("$MonadAppUserModelId = 'ai.monad.app'");
  expect(installer).toContain('monad-shortcut-aumid.exe');
  expect(helper).toContain('PKEY_AppUserModel_ID');
  expect(helper).toContain('PKEY_AppUserModel_ToastActivatorCLSID');
});

test('release packaging carries notification helpers and the cross-platform PNG icon', async () => {
  const release = await Bun.file(join(root, 'scripts/build-release.ts')).text();

  expect(release).toContain("'monad-icon-1024.png'");
  expect(release).toContain("'monad-shortcut-aumid.exe'");
  expect(release).toContain('buildMacOSNotificationApp');
});
