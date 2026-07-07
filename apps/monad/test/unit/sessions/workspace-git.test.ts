import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readWorkspaceGit } from '@/handlers/session/workspace-git.ts';

const tmpDir = () => mkdtempSync(join(tmpdir(), 'monad-git-'));

async function git(cwd: string, ...args: string[]): Promise<void> {
  // Isolate from the host's git config portably (no /dev/null): point GIT_CONFIG_* at nonexistent
  // files, which git treats as empty on every OS.
  const none = join(cwd, '.gitconfig-absent');
  await Bun.$`git ${args}`
    .cwd(cwd)
    .quiet()
    .env({ ...Bun.env, GIT_CONFIG_GLOBAL: none, GIT_CONFIG_SYSTEM: none });
}

test('a non-repo directory reports isRepo:false', async () => {
  expect(await readWorkspaceGit(tmpDir())).toEqual({ isRepo: false });
});

test('a clean repo reports the branch and dirty:false', async () => {
  const dir = tmpDir();
  await git(dir, 'init', '-b', 'work');
  await git(dir, 'config', 'user.email', 't@t.dev');
  await git(dir, 'config', 'user.name', 'T');
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'init');

  const g = await readWorkspaceGit(dir);
  expect(g.isRepo).toBe(true);
  expect(g.branch).toBe('work');
  expect(g.dirty).toBe(false);
});

test('a GitHub origin is exposed as a browser URL', async () => {
  const dir = tmpDir();
  await git(dir, 'init', '-b', 'work');
  await git(dir, 'config', 'user.email', 't@t.dev');
  await git(dir, 'config', 'user.name', 'T');
  await git(dir, 'remote', 'add', 'origin', 'git@github.com:monad/monad.git');
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'init');

  const g = await readWorkspaceGit(dir);
  expect(g.remoteUrl).toBe('https://github.com/monad/monad');
});

test('a non-GitHub origin does not expose an Open in GitHub URL', async () => {
  const dir = tmpDir();
  await git(dir, 'init', '-b', 'work');
  await git(dir, 'config', 'user.email', 't@t.dev');
  await git(dir, 'config', 'user.name', 'T');
  await git(dir, 'remote', 'add', 'origin', 'https://gitlab.com/monad/monad.git');
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'init');

  const _g = await readWorkspaceGit(dir);
});

test('an uncommitted change flips dirty to true', async () => {
  const dir = tmpDir();
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.email', 't@t.dev');
  await git(dir, 'config', 'user.name', 'T');
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'init');
  writeFileSync(join(dir, 'a.txt'), 'changed\n');

  const g = await readWorkspaceGit(dir);
  expect(g.branch).toBe('main');
  expect(g.dirty).toBe(true);
});
