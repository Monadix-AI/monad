import { expect, test } from 'bun:test';
import { join } from 'node:path';

const daemonRoot = join(import.meta.dir, '../..');

test('daemon release graph does not statically depend on the debug power pack', async () => {
  const managerSource = await Bun.file(join(daemonRoot, 'src/handlers/atom-pack/atom-pack-manager.ts')).text();
  const pkg = (await Bun.file(join(daemonRoot, 'package.json')).json()) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  expect(managerSource).not.toContain("from '@monad/monad-power-pack'");
  expect(managerSource).not.toContain('from "@monad/monad-power-pack"');
  expect(managerSource).not.toContain("import('@monad/monad-power-pack')");
  expect(managerSource).not.toContain('import("@monad/monad-power-pack")');
  expect(pkg.dependencies?.['@monad/monad-power-pack']).toBeUndefined();
  expect(pkg.devDependencies?.['@monad/monad-power-pack']).toBe('workspace:*');
});
