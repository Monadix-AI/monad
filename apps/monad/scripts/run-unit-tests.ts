import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const runner = join(import.meta.dir, '../../../scripts/bun-test.ts');

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
  if (files.some((entry) => entry.isFile() && isApplicableWindowsTest(entry.name))) {
    groups.push([`test/unit/${directory.name}/`]);
  }
}
const rootFiles = entries
  .filter((entry) => entry.isFile() && isApplicableWindowsTest(entry.name))
  .sort((left, right) => left.name.localeCompare(right.name))
  .map((entry) => `test/unit/${entry.name}`);

for (let index = 0; index < rootFiles.length; index += 10) {
  groups.push(rootFiles.slice(index, index + 10));
}

let exitCode = 0;
for (const group of groups) {
  const proc = Bun.spawn(['bun', runner, ...group, '--only-failures'], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit'
  });
  const code = await proc.exited;
  if (code !== 0) exitCode = code;
}
process.exit(exitCode);

function isApplicableWindowsTest(name: string): boolean {
  if (!/\.test\.[cm]?[jt]sx?$/.test(name)) return false;
  if (/\.(?:unix|macos|linux)\.test\./.test(name)) return false;
  if (/\.container(?:\.[^.]+)?\.test\./.test(name) && Bun.env.MONAD_TEST_CONTAINER_DEPS !== '1') return false;
  return true;
}
