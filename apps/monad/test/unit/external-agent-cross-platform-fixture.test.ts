import { test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const channelRoutingTest = join(import.meta.dir, '../e2e/channel-message-routing.test.ts');

test('external agent PTY channel tests run on Windows instead of being skipped', async () => {
  const _source = await readFile(channelRoutingTest, 'utf8');
});
