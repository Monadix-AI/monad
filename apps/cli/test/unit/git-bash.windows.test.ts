if (process.platform !== 'win32') process.exit(0);

import { expect, test } from 'bun:test';

import { ensureWindowsShell } from '../../src/lib/git-bash.ts';

test('ensureWindowsShell does not throw when Git Bash is absent', () => {
  // findGitBash() returns null when no Git Bash is installed; ensureWindowsShell
  // should print a warning but never throw.
  expect(() => ensureWindowsShell()).not.toThrow();
});
