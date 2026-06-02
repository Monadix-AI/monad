import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { roleExecPath } from '../../src/process-name.ts';

test('a non-executable role sibling falls back to the primary executable', () => {
  const directory = mkdtempSync(join(tmpdir(), 'monad-process-name-mode-'));
  const execPath = join(directory, 'monad');
  try {
    writeFileSync(execPath, '', { mode: 0o755 });
    writeFileSync(join(directory, 'monad-restart'), '', { mode: 0o644 });
    expect(roleExecPath(execPath, 'restart', 'darwin')).toBe(execPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
