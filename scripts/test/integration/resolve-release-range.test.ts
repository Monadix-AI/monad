import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveReleaseRange } from '../../resolve-release-range.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stderr: 'pipe', stdout: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

async function repository(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'monad-release-range-'));
  temporaryDirectories.push(cwd);
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.email', 'release-test@monadix.ai');
  git(cwd, 'config', 'user.name', 'Release Test');
  git(cwd, 'commit', '--allow-empty', '-m', 'feat: initial release');
  git(cwd, 'tag', 'v0.1.3');
  return cwd;
}

test('stable releases ignore prerelease tags when selecting their exact commit range', async () => {
  const cwd = await repository();
  git(cwd, 'commit', '--allow-empty', '-m', 'test: nightly candidate');
  git(cwd, 'tag', 'v0.1.4-nightly.20260820+abc1234');
  git(cwd, 'commit', '--allow-empty', '-m', 'fix: stable candidate');

  const result = resolveReleaseRange({ cwd, tag: 'v0.1.4', target: 'HEAD' });

  expect(result).toEqual({
    previousTag: 'v0.1.3',
    range: `v0.1.3..${result.targetSha}`,
    targetSha: git(cwd, 'rev-parse', 'HEAD')
  });
});

test('beta and nightly releases select the nearest prerelease ancestor', async () => {
  const cwd = await repository();
  git(cwd, 'commit', '--allow-empty', '-m', 'feat: beta one');
  git(cwd, 'tag', 'v0.1.4-beta.1');
  git(cwd, 'commit', '--allow-empty', '-m', 'fix: beta two');

  const result = resolveReleaseRange({ cwd, tag: 'v0.1.4-beta.2', target: 'HEAD' });

  expect(result.previousTag).toBe('v0.1.4-beta.1');
  expect(result.range).toBe(`v0.1.4-beta.1..${result.targetSha}`);
});

test('the first release spans reachable history from the target commit', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'monad-initial-release-range-'));
  temporaryDirectories.push(cwd);
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.email', 'release-test@monadix.ai');
  git(cwd, 'config', 'user.name', 'Release Test');
  git(cwd, 'commit', '--allow-empty', '-m', 'feat: initial release');

  const result = resolveReleaseRange({ cwd, tag: 'v0.1.0', target: 'HEAD' });

  expect(result).toEqual({ previousTag: null, range: result.targetSha, targetSha: git(cwd, 'rev-parse', 'HEAD') });
});
