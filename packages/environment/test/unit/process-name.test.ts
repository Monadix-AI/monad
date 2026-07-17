import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { roleExecPath } from '../../src/process-name.ts';

describe('roleExecPath', () => {
  let dir: string;
  let execPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'monad-process-name-'));
    execPath = join(dir, 'monad');
    writeFileSync(execPath, '', { mode: 0o755 });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('resolves to the role-named sibling when it exists next to the binary', () => {
    symlinkSync(execPath, join(dir, 'monad-daemon'));
    expect(roleExecPath(execPath, 'daemon', 'darwin')).toBe(join(dir, 'monad-daemon'));
  });

  test('falls back to execPath when no sibling was built (dev run, or a pre-existing install)', () => {
    expect(roleExecPath(execPath, 'restart', 'darwin')).toBe(execPath);
  });

  test('falls back to execPath when the sibling exists but is not executable (partial/corrupted install)', () => {
    writeFileSync(join(dir, 'monad-restart'), '', { mode: 0o644 });
    expect(roleExecPath(execPath, 'restart', 'darwin')).toBe(execPath);
  });

  test('falls back to execPath on Windows even when a same-named sibling exists', () => {
    symlinkSync(execPath, join(dir, 'monad-watchdog'));
    expect(roleExecPath(execPath, 'watchdog', 'win32')).toBe(execPath);
  });
});
