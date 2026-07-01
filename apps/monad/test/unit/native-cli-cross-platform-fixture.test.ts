import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const channelRoutingTest = join(import.meta.dir, '../e2e/channel-message-routing.test.ts');

test('native CLI PTY channel tests run on Windows instead of being skipped', async () => {
  const source = await readFile(channelRoutingTest, 'utf8');
  expect(source).not.toContain("test.skipIf(process.platform === 'win32')");
  expect(source).toContain("process.platform === 'win32' ? process.execPath : script");
  expect(source).toContain("process.platform === 'win32' ? [script] : []");
});
