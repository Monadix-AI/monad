import type { FileObservationStore, ToolContext } from '#/capabilities/tools/types.ts';

import { afterAll, beforeAll, expect, test } from 'bun:test';

if (process.platform === 'win32') process.exit(0);

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fileReadTool, fileWriteTool, ToolSecurityError } from '#/capabilities/tools';

let root: string;
const observations = new Map<string, Awaited<ReturnType<FileObservationStore['get']>>>();
const fileObservations: FileObservationStore = {
  remember(sessionId, observation) {
    observations.set(`${sessionId}:${observation.path}`, observation);
  },
  get(sessionId, path) {
    return observations.get(`${sessionId}:${path}`) ?? null;
  }
};
const ctx = (roots: string[] | undefined): ToolContext => ({
  sessionId: 's1',
  sandboxRoots: roots,
  fileObservations,
  log: () => {}
});

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'monad-fs-unix-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\nconst secret = "needle";\n');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

// Symlink creation needs admin/developer mode on Windows — this file runs on Unix only.
test('file_read follows a symlink only if its target stays in the sandbox', async () => {
  const link = join(root, 'link-out');
  await symlink('/etc/passwd', link).catch(() => {});
  await expect(fileReadTool.run({ path: link }, ctx([root]))).rejects.toBeInstanceOf(ToolSecurityError);
});

test('file_write refuses to write through a symlink leaf that escapes the sandbox', async () => {
  const target = join(tmpdir(), `monad-escape-${Date.now()}.txt`);
  await writeFile(target, 'do-not-touch');
  const link = join(root, 'write-link-out');
  await symlink(target, link).catch(() => {});
  await expect(fileWriteTool.run({ path: link, content: 'pwned' }, ctx([root]))).rejects.toBeInstanceOf(
    ToolSecurityError
  );
  expect(await Bun.file(target).text()).toBe('do-not-touch'); // the escaping write never landed
  await rm(target, { force: true });
});

test('file_write still follows an in-sandbox symlink (target stays inside roots)', async () => {
  const realFile = join(root, 'real.txt');
  await writeFile(realFile, 'orig');
  const link = join(root, 'write-link-in');
  await symlink(realFile, link).catch(() => {});
  const c = ctx([root]);
  await fileReadTool.run({ path: link }, c);
  await fileWriteTool.run({ path: link, content: 'updated' }, c);
  expect(await Bun.file(realFile).text()).toBe('updated');
});
