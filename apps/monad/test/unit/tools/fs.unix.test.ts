import type { ToolContext } from '@/capabilities/tools/types.ts';

import { afterAll, beforeAll, expect, test } from 'bun:test';

if (process.platform === 'win32') process.exit(0);

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fsReadTool, fsWriteTool, ToolSecurityError } from '@/capabilities/tools';

let root: string;
const ctx = (roots: string[] | undefined): ToolContext => ({ sessionId: 's1', sandboxRoots: roots, log: () => {} });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'monad-fs-unix-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\nconst secret = "needle";\n');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

// Symlink creation needs admin/developer mode on Windows — this file runs on Unix only.
test('fs_read follows a symlink only if its target stays in the sandbox', async () => {
  const link = join(root, 'link-out');
  await symlink('/etc/passwd', link).catch(() => {});
  await expect(fsReadTool.run({ path: link }, ctx([root]))).rejects.toBeInstanceOf(ToolSecurityError);
});

test('fs_write refuses to write through a symlink leaf that escapes the sandbox', async () => {
  const target = join(tmpdir(), `monad-escape-${Date.now()}.txt`);
  await writeFile(target, 'do-not-touch');
  const link = join(root, 'write-link-out');
  await symlink(target, link).catch(() => {});
  await expect(fsWriteTool.run({ path: link, content: 'pwned' }, ctx([root]))).rejects.toBeInstanceOf(
    ToolSecurityError
  );
  expect(await Bun.file(target).text()).toBe('do-not-touch'); // the escaping write never landed
  await rm(target, { force: true });
});

test('fs_write still follows an in-sandbox symlink (target stays inside roots)', async () => {
  const realFile = join(root, 'real.txt');
  await writeFile(realFile, 'orig');
  const link = join(root, 'write-link-in');
  await symlink(realFile, link).catch(() => {});
  await fsWriteTool.run({ path: link, content: 'updated' }, ctx([root]));
  expect(await Bun.file(realFile).text()).toBe('updated');
});
