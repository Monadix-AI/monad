import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateReleaseChangelog } from '../../generate-release-changelog.ts';

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
  const cwd = await mkdtemp(join(tmpdir(), 'monad-release-changelog-'));
  temporaryDirectories.push(cwd);
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.email', 'release-test@monadix.ai');
  git(cwd, 'config', 'user.name', 'Release Test');
  git(cwd, 'commit', '--allow-empty', '-m', 'feat: initial release');
  git(cwd, 'tag', 'v0.1.3');
  git(cwd, 'tag', 'v0.1.3-nightly.20260810');
  return cwd;
}

test('release changelog contains every conventional commit in the actual tag range and is idempotent', async () => {
  const cwd = await repository();
  git(cwd, 'commit', '--allow-empty', '-m', 'feat(ui): ship the intended feature');
  git(cwd, 'switch', '-c', 'release-fix');
  git(cwd, 'commit', '--allow-empty', '-m', 'fix(ci): repair the failed release gate');
  git(cwd, 'switch', 'main');
  git(cwd, 'merge', '--no-ff', 'release-fix', '-m', 'Merge branch release-fix');
  git(cwd, 'commit', '--allow-empty', '-m', 'emergency patch without a conventional type');
  git(cwd, 'commit', '--allow-empty', '-m', 'test(release): cover the retry');
  const target = git(cwd, 'rev-parse', 'HEAD');
  const output = join(cwd, 'release-notes.md');

  const first = await generateReleaseChangelog({
    cwd,
    output,
    repository: 'Monadix-AI/monad',
    tag: 'v0.1.4',
    target
  });
  const second = await generateReleaseChangelog({
    cwd,
    output,
    repository: 'Monadix-AI/monad',
    tag: 'v0.1.4',
    target
  });

  expect(first.previousTag).toBe('v0.1.3');
  expect(first.commits.map((commit) => commit.subject)).toEqual([
    'feat(ui): ship the intended feature',
    'fix(ci): repair the failed release gate',
    'test(release): cover the retry'
  ]);
  expect(second.body).toBe(first.body);
  expect(await Bun.file(output).text()).toBe(first.body);
  expect(first.body).toContain('compare/v0.1.3...v0.1.4');
  expect(first.body).toContain('### Features\n\n* feat(ui): ship the intended feature');
  expect(first.body).toContain('### Bug Fixes\n\n* fix(ci): repair the failed release gate');
  expect(first.body).toContain('### Tests\n\n* test(release): cover the retry');
  expect(first.body).not.toContain('### Other Changes');
});

test('an existing current tag is excluded when resolving the previous release', async () => {
  const cwd = await repository();
  git(cwd, 'commit', '--allow-empty', '-m', 'test: build the intervening nightly');
  git(cwd, 'tag', 'v0.1.4-nightly.20260811');
  git(cwd, 'commit', '--allow-empty', '-m', 'chore: publish exact history');
  git(cwd, 'tag', 'v0.1.4');

  const result = await generateReleaseChangelog({
    cwd,
    repository: 'Monadix-AI/monad',
    tag: 'v0.1.4',
    target: 'v0.1.4'
  });

  expect(result.previousTag).toBe('v0.1.3');
  expect(result.commits.map((commit) => commit.subject)).toEqual([
    'test: build the intervening nightly',
    'chore: publish exact history'
  ]);
});

test('the first release includes conventional history from the repository root', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'monad-initial-release-changelog-'));
  temporaryDirectories.push(cwd);
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.email', 'release-test@monadix.ai');
  git(cwd, 'config', 'user.name', 'Release Test');
  git(cwd, 'commit', '--allow-empty', '-m', 'feat: establish the initial release');
  git(cwd, 'commit', '--allow-empty', '-m', 'notes without a conventional type');
  git(cwd, 'tag', 'v0.1.0');

  const result = await generateReleaseChangelog({
    cwd,
    repository: 'Monadix-AI/monad',
    tag: 'v0.1.0',
    target: 'v0.1.0'
  });

  expect(result.previousTag).toBeNull();
  expect(result.commits.map((commit) => commit.subject)).toEqual(['feat: establish the initial release']);
  expect(result.body).toContain('https://github.com/Monadix-AI/monad/commits/v0.1.0');
});

test('valid custom conventional types are grouped under Other Changes', async () => {
  const cwd = await repository();
  git(cwd, 'commit', '--allow-empty', '-m', 'security(runtime): harden release credentials');

  const result = await generateReleaseChangelog({
    cwd,
    repository: 'Monadix-AI/monad',
    tag: 'v0.1.4',
    target: 'HEAD'
  });

  expect(result.body).toContain('### Other Changes\n\n* security(runtime): harden release credentials');
});
