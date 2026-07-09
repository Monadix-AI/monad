import type { SandboxLauncher } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';
import { loadManifestAtomPack } from '@monad/sdk-atom';

import { monadPowerPack, stagedMonadPowerPack } from '../../src/index.ts';

test('stagedMonadPowerPack stages the REAL sandbox pack (not a skills placeholder)', () => {
  const staged = stagedMonadPowerPack();
  const manifest = staged.manifestRaw as { atoms: string[]; entry?: string };
  // The dev network-install sim must now install the sandbox atoms, so backend=docker|e2b|vm is usable.
  expect(manifest.atoms).toContain('sandbox');
  expect(staged.fileAtoms.skills).toEqual([]);
  // The on-disk bundle re-exports the real pack; its bare specifier resolves from node_modules at load.
  const bundle = new TextDecoder().decode(staged.files.get('dist/atom-pack.js'));
  expect(bundle).toContain("from '@monad/monad-power-pack'");
  expect(bundle).toContain('monadPowerPack as default');
});

test('the real pack register() registers the docker/e2b/vm launchers through the gated loader', async () => {
  const got: SandboxLauncher[] = [];
  await loadManifestAtomPack(monadPowerPack, {
    registerConnector: () => {},
    registerChannel: () => {},
    registerCommand: () => {},
    registerMessageType: () => {},
    registerSandbox: (l) => got.push(l)
  });
  expect(got.map((l) => l.kind).sort()).toEqual(['docker', 'e2b', 'vm']);
});
