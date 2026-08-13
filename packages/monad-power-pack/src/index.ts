// @monad/monad-power-pack — the opt-in heavy sandbox atom pack. The light OS launchers (Seatbelt /
// bwrap / Landlock / AppContainer) are the always-on default in @monad/sandbox; the HEAVY docker/e2b
// launchers live here and are used only when an operator enables this pack and selects the backend
// via config.sandbox.backend. Keeps docker/e2b (and the e2b npm dep) out of the always-on
// built-in atoms pack.

import { parseAtomPackManifest } from '@monad/protocol';
import { defineAtomPack } from '@monad/sdk-atom';

import manifestJson from '../atom-pack.json' with { type: 'json' };
import { detectDockerRuntime, dockerLauncher, dockerRuntimeAvailable } from './docker.ts';
import { __setE2bLoaderForTest, configureE2bApiKey, e2bLauncher } from './e2b.ts';
import { kanbanApi } from './experiences/kanban/api.ts';
import { kanbanWorker } from './experiences/kanban/worker.ts';
import { kanbanWorkplaceExperience } from './experiences/kanban.ts';

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
  manifest: parseAtomPackManifest(manifestJson),
  sandboxes: [dockerLauncher, e2bLauncher],
  workplaceExperiences: [kanbanWorkplaceExperience],
  workplaceExperienceApis: [kanbanApi],
  experienceWorkers: [kanbanWorker]
});

export default monadPowerPack;
