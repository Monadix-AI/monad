import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { mapWithConcurrency } from '../../../scripts/lib/map-with-concurrency.ts';
import { testFileAppliesToPlatform } from '../../../scripts/lib/platform-test-files.ts';

const runner = join(import.meta.dir, '../../../scripts/bun-test.ts');
const windowsTestConcurrency = 2;
const applies = (name: string): boolean =>
  testFileAppliesToPlatform(name, 'win32', { containerDeps: Bun.env.MONAD_TEST_CONTAINER_DEPS === '1' });

if (process.platform !== 'win32') {
  const proc = Bun.spawn(['bun', runner, 'test/unit/', '--only-failures'], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit'
  });
  process.exit(await proc.exited);
}

const entries = await readdir(join(import.meta.dir, '../test/unit'), { withFileTypes: true });
const directories = entries
  .filter((entry) => entry.isDirectory())
  .sort((left, right) => left.name.localeCompare(right.name));
const groups: string[][] = [];
for (const directory of directories) {
  const files = await readdir(join(import.meta.dir, '../test/unit', directory.name), {
    recursive: true,
    withFileTypes: true
  });
  if (files.some((entry) => entry.isFile() && applies(entry.name))) {
    groups.push([`test/unit/${directory.name}/`]);
  }
}
const rootFiles = entries
  .filter((entry) => entry.isFile() && applies(entry.name))
  .sort((left, right) => left.name.localeCompare(right.name))
  .map((entry) => `test/unit/${entry.name}`);

for (let index = 0; index < rootFiles.length; index += 10) {
  groups.push(rootFiles.slice(index, index + 10));
}

const results = await mapWithConcurrency(groups, windowsTestConcurrency, async (group) => {
  const proc = Bun.spawn(['bun', runner, ...group, '--only-failures'], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit'
  });
  return await proc.exited;
});
process.exit(results.find((code) => code !== 0) ?? 0);
