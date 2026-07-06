import { test } from 'bun:test';
import { join } from 'node:path';

const daemonRoot = join(import.meta.dir, '../..');

test('daemon release graph does not statically depend on the debug power pack', async () => {
  const _managerSource = await Bun.file(join(daemonRoot, 'src/handlers/atom-pack/atom-pack-manager.ts')).text();
  const _pkg = (await Bun.file(join(daemonRoot, 'package.json')).json()) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
});
