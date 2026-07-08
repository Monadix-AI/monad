import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import {
  createSessionSandbox,
  disposeSessionSandbox,
  sandboxDirName,
  sessionSandboxPath,
  sweepOrphanSandboxes
} from '#/capabilities/tools';

const made: string[] = [];
async function base(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sbx-base-'));
  made.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(made.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

test('sandboxDirName keeps simple ids and neutralizes traversal', () => {
  expect(sandboxDirName('sess_abc-123')).toBe('sess_abc-123');
  expect(sandboxDirName('..')).not.toBe('..');
  expect(sandboxDirName('a/b')).toBe('a_b');
});

test('a session root stays inside baseDir even for a hostile id', () => {
  const baseDir = join(tmpdir(), 'monad-sbx');
  const p = sessionSandboxPath(baseDir, '../../escape');
  expect(p.startsWith(baseDir + sep)).toBe(true);
});

test('create then dispose removes the root and its contents', async () => {
  const baseDir = await base();
  const dir = await createSessionSandbox(baseDir, 'sess_1');
  await writeFile(join(dir, 'download.bin'), 'data');
  expect(existsSync(join(dir, 'download.bin'))).toBe(true);

  await disposeSessionSandbox(baseDir, 'sess_1');
  expect(existsSync(dir)).toBe(false);
});

test('create is idempotent and dispose tolerates a missing root', async () => {
  const baseDir = await base();
  const a = await createSessionSandbox(baseDir, 'sess_x');
  const b = await createSessionSandbox(baseDir, 'sess_x');
  expect(a).toBe(b);
  await disposeSessionSandbox(baseDir, 'never-existed'); // must not throw
});

test('sweep removes orphan roots but keeps the active sessions', async () => {
  const baseDir = await base();
  await createSessionSandbox(baseDir, 'live-1');
  await createSessionSandbox(baseDir, 'live-2');
  await createSessionSandbox(baseDir, 'dead-1');
  await createSessionSandbox(baseDir, 'dead-2');

  const removed = await sweepOrphanSandboxes(baseDir, ['live-1', 'live-2']);
  expect(removed).toBe(2);
  expect(existsSync(sessionSandboxPath(baseDir, 'live-1'))).toBe(true);
  expect(existsSync(sessionSandboxPath(baseDir, 'dead-1'))).toBe(false);
});

test('sweep on a non-existent baseDir is a no-op', async () => {
  expect(await sweepOrphanSandboxes(join(tmpdir(), 'monad-sbx-nope-zzz'), [])).toBe(0);
});
