import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startupIconPath } from '#/handlers/settings/startup/startup-platform-common.ts';

test('installed daemon resolves the startup icon from Monad home assets', async () => {
  const monadHome = await mkdtemp(join(tmpdir(), 'monad-startup-icon-path-'));
  const icon = join(monadHome, 'assets', 'monad-icon-vector-solid.svg');
  try {
    await mkdir(join(monadHome, 'bin'), { recursive: true });
    await mkdir(join(monadHome, 'assets'), { recursive: true });
    await writeFile(icon, '<svg/>');

    expect(startupIconPath('darwin', [join(monadHome, 'bin', 'monad-daemon'), 'daemon'], monadHome)).toBe(icon);
  } finally {
    await rm(monadHome, { recursive: true, force: true });
  }
});
