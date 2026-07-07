import { expect, test } from 'bun:test';
import { githubSourceIdentity, parseGithubReleaseSource, parseGithubSource } from '@monad/utils';

test('parseGithubSource handles shorthand, repo URLs, subdirectories, SKILL.md pages, and skill selectors', () => {
  expect(parseGithubSource('github:o/r@abc123')).toMatchObject({
    owner: 'o',
    repo: 'r',
    ref: 'abc123'
  });
  expect(parseGithubSource('https://github.com/acme/suite?skill=beta')).toMatchObject({
    owner: 'acme',
    repo: 'suite',
    ref: 'main',
    skill: 'beta'
  });
  expect(parseGithubSource('https://github.com/acme/skills/tree/main/pixel2motion')).toMatchObject({
    owner: 'acme',
    repo: 'skills',
    ref: 'main',
    path: 'pixel2motion'
  });
  expect(parseGithubSource('https://github.com/acme/skills/blob/main/pixel2motion/SKILL.md')).toMatchObject({
    owner: 'acme',
    repo: 'skills',
    ref: 'main',
    path: 'pixel2motion'
  });
});

test('parseGithubSourceOrNull returns null for unsupported sources', () => {});

test('githubSourceIdentity ignores ref but preserves repo path and skill selector', () => {
  expect(githubSourceIdentity(parseGithubSource('github:acme/skills@main/pixel2motion'))).toBe(
    'github:acme/skills/pixel2motion'
  );
  expect(githubSourceIdentity(parseGithubSource('github:acme/skills@v2/pixel2motion'))).toBe(
    'github:acme/skills/pixel2motion'
  );
  expect(githubSourceIdentity(parseGithubSource('https://github.com/acme/skills?skill=beta'))).toBe(
    'github:acme/skills?skill=beta'
  );
});

test('parseGithubReleaseSource handles owner repo tag release specs', () => {
  expect(parseGithubReleaseSource('owner/repo@v1.0.0')).toEqual({
    owner: 'owner',
    repo: 'repo',
    tag: 'v1.0.0',
    spec: 'owner/repo@v1.0.0'
  });
});

test('parseGithubReleaseSource rejects invalid release specs', () => {
  expect(() => parseGithubReleaseSource('owner/repo')).toThrow('invalid github release source');
  expect(() => parseGithubReleaseSource('github:owner/repo@v1')).toThrow('invalid github release source');
});
