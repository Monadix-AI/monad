// @monad/monad-power-pack — the opt-in heavy sandbox atom pack. The light OS launchers (Seatbelt /
// bwrap / Landlock / AppContainer) are the always-on default in @monad/sandbox; the HEAVY docker/e2b
// launchers live here and are used only when an operator enables this pack and selects the backend
// via config.sandbox.backend. Keeps docker/e2b (and the e2b npm dep) out of the always-on
// built-in atoms pack.

import { readFileSync } from 'node:fs';
import { defineAtomPack, SDK_VERSION } from '@monad/sdk-atom';

import { detectDockerRuntime, dockerLauncher, dockerRuntimeAvailable } from './docker.ts';
import { __setE2bLoaderForTest, configureE2bApiKey, e2bLauncher } from './e2b.ts';
import { kanbanWorkspaceExperience } from './experiences/kanban.ts';

export {
  __setE2bLoaderForTest,
  configureE2bApiKey,
  detectDockerRuntime,
  dockerLauncher,
  dockerRuntimeAvailable,
  e2bLauncher
};

/** The heavy-sandbox atom pack: declares the `sandbox` atom kind and contributes the docker + e2b
 *  launchers. An enabled pack registers these into the launcher registry (source 'atom'); the daemon
 *  selects one only when config.sandbox.backend names it. */
export const monadPowerPack = defineAtomPack({
  manifest: {
    name: 'monad-power-pack',
    version: '0.0.1',
    sdkVersion: SDK_VERSION,
    atoms: ['sandbox', 'workspace-experience'],
    description: 'Opt-in contributed sandbox backends (Docker/Podman and E2B) for the monad agent.',
    author: 'Monadix Labs'
  },
  sandboxes: [dockerLauncher, e2bLauncher],
  workspaceExperiences: [kanbanWorkspaceExperience]
});

export const MONAD_POWER_PACK_DEBUG_SOURCE = 'debug:monad-power-pack';
export const MONAD_POWER_PACK_GITHUB_SOURCE = 'github:monadix-labs/monad-power-pack@debug';

// Staged form of the REAL pack for the dev "install from the network" simulation. atom-pack-packs.ts
// serves this when a client installs source `debug:monad-power-pack` (NODE_ENV≠production). The on-disk
// bundle re-exports `monadPowerPack` from this dev checkout by file URL. Installed packs live below
// `.dev/.monad`, where a workspace bare specifier cannot resolve; the explicit URL keeps this dev-only
// simulation loadable while still exercising the real on-disk discovery and registration path.
const stagedManifest = {
  ...monadPowerPack.manifest,
  entry: 'dist/atom-pack.js',
  source: { repo: 'monadix-labs/monad-power-pack', commit: 'debug' }
};

const stagedBundle = `export { monadPowerPack as default } from ${JSON.stringify(import.meta.url)};\n`;
const kanbanAsset = readFileSync(new URL('./experiences/kanban.js', import.meta.url));

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
    files: new Map([
      ['dist/atom-pack.js', bytes],
      ['experiences/kanban.js', kanbanAsset]
    ])
  };
}
