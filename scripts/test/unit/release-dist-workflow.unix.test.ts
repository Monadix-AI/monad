import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// upgrade-dist-e2e.ts refuses to run on win32 before it reaches any scenario, so its
// failure-reporting contract can only be exercised on the Unix release runners.
const root = resolve(import.meta.dir, '../../..');

test('a failing upgrade scenario does not hide the scenarios after it', async () => {
  const script = join(root, 'scripts/test/upgrade-dist-e2e.ts');
  const dir = mkdtempSync(join(tmpdir(), 'monad-upgrade-args-'));

  try {
    // Both scenarios are selected, and the CLI one fails immediately because the artifact
    // directories are empty. Short-circuiting would name only `cli`; reporting all names both.
    const proc = Bun.spawn(['bun', script, '--old-dir', dir, '--new-dir', dir, '--tag', 'v0.0.2'], {
      stderr: 'pipe',
      stdout: 'pipe'
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect({
      exitCode,
      reportsEveryFailedScenario: /failed scenarios: .*cli.*web|failed scenarios: .*web.*cli/.test(stderr)
    }).toEqual({ exitCode: 1, reportsEveryFailedScenario: true });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
