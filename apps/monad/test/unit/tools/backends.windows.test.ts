if (process.platform !== 'win32') process.exit(0);

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configureShell, findGitBash, shellArgv } from '#/capabilities/tools/backends.ts';

const FAKE_BASH = join(tmpdir(), 'fake-bash.exe');

beforeEach(() => {
  writeFileSync(FAKE_BASH, '');
});

afterEach(async () => {
  configureShell({});
  await rm(FAKE_BASH, { force: true });
  delete Bun.env.CLAUDE_CODE_GIT_BASH_PATH;
});

test('findGitBash returns the explicit path when CLAUDE_CODE_GIT_BASH_PATH points to a real file', () => {
  Bun.env.CLAUDE_CODE_GIT_BASH_PATH = FAKE_BASH;
  expect(findGitBash()).toBe(FAKE_BASH);
});

test('findGitBash returns the explicitPath argument when it exists on disk', () => {
  expect(findGitBash(FAKE_BASH)).toBe(FAKE_BASH);
});

test('findGitBash returns null when no bash candidate exists', () => {
  delete Bun.env.CLAUDE_CODE_GIT_BASH_PATH;
  // Temporarily clear ProgramFiles env vars so system Git Bash isn't discovered.
  const pf = Bun.env.ProgramFiles;
  const pf86 = Bun.env['ProgramFiles(x86)'];
  const lad = Bun.env.LOCALAPPDATA;
  delete Bun.env.ProgramFiles;
  delete Bun.env['ProgramFiles(x86)'];
  delete Bun.env.LOCALAPPDATA;
  try {
  } finally {
    if (pf !== undefined) Bun.env.ProgramFiles = pf;
    if (pf86 !== undefined) Bun.env['ProgramFiles(x86)'] = pf86;
    if (lad !== undefined) Bun.env.LOCALAPPDATA = lad;
  }
});

test('shellArgv uses the configured Git Bash on Windows', () => {
  configureShell({ gitBashPath: FAKE_BASH });
  expect(shellArgv('echo hi')).toEqual([FAKE_BASH, '-c', 'echo hi']);
});

test('shellArgv with a direct shellPath override bypasses Git Bash lookup', () => {
  configureShell({ shellPath: FAKE_BASH });
  expect(shellArgv('echo hi')).toEqual([FAKE_BASH, '-c', 'echo hi']);
});
