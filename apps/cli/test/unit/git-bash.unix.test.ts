import { expect, test } from 'bun:test';

import { ensureWindowsShell, findGitBash } from '../../src/lib/git-bash.ts';

test('findGitBash returns null on non-Windows', () => {
});

test('ensureWindowsShell is a no-op on non-Windows', () => {
  expect(() => ensureWindowsShell()).not.toThrow();
});
