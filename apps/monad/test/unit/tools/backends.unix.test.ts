if (process.platform === 'win32') process.exit(0);

import { afterEach, expect, test } from 'bun:test';

import { configureShell, findGitBash, shellArgv } from '#/capabilities/tools/backends.ts';

afterEach(() => {
  // Reset the lazy shell cache so tests don't bleed into each other.
  configureShell({});
});

test('findGitBash returns null on non-Windows', () => {
  expect(findGitBash('/bin/bash')).toBeNull();
});

test('shellArgv produces /bin/sh -c on non-Windows', () => {
  configureShell({});
  expect(shellArgv('echo hi')).toEqual(['/bin/sh', '-c', 'echo hi']);
});

test('configureShell overrides the shell binary', () => {
  configureShell({ shellPath: '/usr/bin/bash' });
  expect(shellArgv('echo hi')).toEqual(['/usr/bin/bash', '-c', 'echo hi']);
});
