import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('CLI dispatches the hidden daemon child supervisor before public command parsing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'monad-child-supervisor-dispatch-'));
  try {
    const proc = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, '../../src/bin.ts'),
        '--daemon-child-supervisor',
        '2147483647',
        join(dir, 'children.json')
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text()
    ]);

    expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: '', stderr: '' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
