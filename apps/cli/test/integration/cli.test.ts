import { expect, test } from 'bun:test';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { runDev } from '../../src/dev.ts';

test('dev entry returns success code for one-shot command paths', async () => {
  const originalArgv = process.argv;
  process.argv = [process.argv[0] ?? 'bun', process.argv[1] ?? 'dev.ts', '--version'];
  try {
    const code = await runDev();
    expect(code).toBe(0);
  } finally {
    process.argv = originalArgv;
  }
});

test('atom pack runs without resolving a daemon connection', async () => {
  const root = join(tmpdir(), `monad-cli-pack-${process.pid}-${Date.now()}`);
  const output = join(root, 'release', 'atom-pack.zip');
  await mkdir(join(root, 'dist'), { recursive: true });
  await Bun.write(
    join(root, 'atom-pack.json'),
    `${JSON.stringify({ name: 'cli-pack', version: '1.0.0', sdkVersion: '0', atoms: [] })}\n`
  );
  await Bun.write(join(root, 'dist', 'atom-pack.js'), 'export default { manifest: {}, register() {} };\n');

  try {
    const proc = Bun.spawn(
      [process.execPath, resolve(import.meta.dir, '../../src/main.ts'), 'atom', 'pack', root, '--out', output],
      { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, MONAD_SERVER_URL: 'http://127.0.0.1:1' } }
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text()
    ]);
    const artifact = await readFile(output);
    const sha256 = new Bun.CryptoHasher('sha256').update(artifact).digest('hex');

    expect({ exitCode, stderr, zipHeader: [...artifact.subarray(0, 4)] }).toEqual({
      exitCode: 0,
      stderr: '',
      zipHeader: [80, 75, 3, 4]
    });
    expect(stdout.replaceAll('\r\n', '\n')).toBe(`packed Atom Pack ${output}\nSHA-256 ${sha256}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
