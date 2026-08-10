import { expect, test } from 'bun:test';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');

test('dist installer enhancement preserves the product and download contracts', async () => {
  const enhancer = await Bun.file(join(root, 'scripts/enhance-dist-installers.ts')).text();
  const docs = (await Bun.file(join(root, 'docs/docs.json')).json()) as {
    description: string;
  };

  expect(docs.description).toBe('Daemon-first agent team runtime with headless architecture.');
  expect(enhancer).toContain(docs.description);
  expect(enhancer).not.toContain('Local AI runtime');
  expect(enhancer).toContain('monad_download_progress "$1" "$2"');
  expect(enhancer).not.toContain('--silent --head');
  expect(enhancer).toContain('--retry 3');
  expect(enhancer).toContain('MONAD_OUTPUT:-');
  expect(enhancer).toContain("$env:MONAD_OUTPUT -eq 'json'");
  expect(enhancer).toContain('Write-Progress -Activity "Downloading Monad $app_version"');
  expect(enhancer).toContain('rename(generatedShell, shellInstaller)');
  expect(enhancer).toContain('rename(generatedPowerShell, powerShellInstaller)');
});
