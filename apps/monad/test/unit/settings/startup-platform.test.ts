import { expect, test } from 'bun:test';

import { startupPlatformModule as darwin } from '#/handlers/settings/startup/startup-platform.darwin.ts';
import { startupPlatformModule as linux } from '#/handlers/settings/startup/startup-platform.linux.ts';
import { startupPlatformModule as windows } from '#/handlers/settings/startup/startup-platform.windows.ts';

test('target startup modules expose only their native platform', () => {
  expect(darwin.current.platform).toBe('darwin');
  expect(linux.current.platform).toBe('linux');
  expect(windows.current.platform).toBe('win32');
  expect(darwin.forPlatform('linux')).toBeNull();
  expect(linux.forPlatform('win32')).toBeNull();
  expect(windows.forPlatform('darwin')).toBeNull();
});
