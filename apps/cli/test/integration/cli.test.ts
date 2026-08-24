import { expect, test } from 'bun:test';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  const originalArgv = process.argv;
  const originalServerUrl = process.env.MONAD_SERVER_URL;
  await mkdir(join(root, 'dist'), { recursive: true });
  await Bun.write(
    join(root, 'atom-pack.json'),
    `${JSON.stringify({ name: 'cli-pack', version: '1.0.0', sdkVersion: '0', atoms: [] })}\n`
  );
  await Bun.write(join(root, 'dist', 'atom-pack.js'), 'export default { manifest: {}, register() {} };\n');

  try {
    process.argv = [process.execPath, process.argv[1] ?? 'dev.ts', 'atom', 'pack', root, '--out', output];
    process.env.MONAD_SERVER_URL = 'http://127.0.0.1:1';

    const exitCode = await runDev();
    const artifact = await readFile(output);

    expect({ exitCode, zipHeader: [...artifact.subarray(0, 4)] }).toEqual({
      exitCode: 0,
      zipHeader: [80, 75, 3, 4]
    });
  } finally {
    process.argv = originalArgv;
    if (originalServerUrl === undefined) {
      delete process.env.MONAD_SERVER_URL;
    } else {
      process.env.MONAD_SERVER_URL = originalServerUrl;
    }
    await rm(root, { recursive: true, force: true });
  }
});
