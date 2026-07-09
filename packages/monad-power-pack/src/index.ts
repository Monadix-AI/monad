// @monad/monad-power-pack — the opt-in heavy sandbox atom pack. The light OS launchers (Seatbelt /
// bwrap / Landlock / AppContainer) are the always-on default in @monad/sandbox; the HEAVY docker/e2b
// launchers live here and are used only when an operator enables this pack and selects the backend
// via config.sandbox.backend. Keeps docker/e2b (and the e2b npm dep) out of the always-on
// built-in atoms pack.

import { vmLauncher } from '@monad/sandbox-vm';
import { defineAtomPack, SDK_VERSION } from '@monad/sdk-atom';

import { detectDockerRuntime, dockerLauncher, dockerRuntimeAvailable } from './docker.ts';
import { __setE2bLoaderForTest, configureE2bApiKey, e2bLauncher } from './e2b.ts';

export {
  __setE2bLoaderForTest,
  configureE2bApiKey,
  detectDockerRuntime,
  dockerLauncher,
  dockerRuntimeAvailable,
  e2bLauncher,
  vmLauncher
};

/** The heavy-sandbox atom pack: declares the `sandbox` atom kind and contributes the docker + e2b
 *  launchers. An enabled pack registers these into the launcher registry (source 'atom'); the daemon
 *  selects one only when config.sandbox.backend names it. */
export const monadPowerPack = defineAtomPack({
  manifest: {
    name: 'monad-power-pack',
    version: '0.0.1',
    sdkVersion: SDK_VERSION,
    atoms: ['sandbox'],
    description: 'Opt-in heavy sandbox backends (Docker/Podman, E2B, VM) for the monad agent.',
    author: 'Monadix Labs'
  },
  sandboxes: [dockerLauncher, e2bLauncher, vmLauncher]
});

export const MONAD_POWER_PACK_DEBUG_SOURCE = 'debug:monad-power-pack';
export const MONAD_POWER_PACK_GITHUB_SOURCE = 'github:monadix-labs/monad-power-pack@debug';

// Staged form of the REAL pack for the dev "install from the network" simulation. atom-pack-packs.ts
// serves this when a client installs source `debug:monad-power-pack` (NODE_ENV≠production). The on-disk
// bundle re-exports `monadPowerPack`; its bare specifier resolves from the worktree node_modules, so at
// discovery time register() registers the docker/e2b/vm sandbox launchers exactly like a fetched pack
// would. Installing it + setting agent.sandbox.backend=docker|e2b|vm makes that heavy backend selectable.
const stagedManifest = {
  ...monadPowerPack.manifest,
  entry: 'dist/atom-pack.js',
  source: { repo: 'monadix-labs/monad-power-pack', commit: 'debug' }
};

const stagedBundle = "export { monadPowerPack as default } from '@monad/monad-power-pack';\n";

export function stagedMonadPowerPack(): {
  manifestRaw: unknown;
  bundle: Uint8Array;
  fileAtoms: { skills: string[]; mcpServers: string[]; locales: string[] };
  files: Map<string, Uint8Array>;
} {
  const bytes = new TextEncoder().encode(stagedBundle);
  return {
    manifestRaw: stagedManifest,
    bundle: bytes,
    fileAtoms: { skills: [], mcpServers: [], locales: [] },
    files: new Map([['dist/atom-pack.js', bytes]])
  };
}
