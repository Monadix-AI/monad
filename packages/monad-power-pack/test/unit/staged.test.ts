import type {
  ExperienceWorker,
  SandboxLauncher,
  WorkspaceExperienceApi,
  WorkspaceExperienceDefinition
} from '@monad/sdk-atom';

import { expect, test } from 'bun:test';
import { loadManifestAtomPack } from '@monad/sdk-atom';

import { monadPowerPack, stagedMonadPowerPack } from '../../src/index.ts';

test('stagedMonadPowerPack stages the REAL sandbox pack (not a skills placeholder)', () => {
  const staged = stagedMonadPowerPack();
  const manifest = staged.manifestRaw as { atoms: string[]; entry?: string };
  // The dev network-install sim installs the contributed Docker/E2B sandbox atoms.
  expect(manifest.atoms).toContain('sandbox');
  expect(manifest.atoms).toContain('workspace-experience');
  expect((manifest as { permissions?: string[] }).permissions).toContain('experience.worker');
  expect(staged.fileAtoms.skills).toEqual([]);
  // The installed dev bundle resolves the real pack explicitly; installed directories are outside
  // the workspace package-resolution chain, so a bare @monad import would fail discovery.
  const bundle = new TextDecoder().decode(staged.files.get('dist/atom-pack.js'));
  expect(bundle).toContain('from "file:');
  expect(bundle).toContain('monadPowerPack as default');
  const kanban = new TextDecoder().decode(staged.files.get('experiences/kanban.js'));
  expect(kanban).toContain("customElements.define('monad-kanban'");
});

test('the real pack register() registers the docker/e2b launchers through the gated loader', async () => {
  const got: SandboxLauncher[] = [];
  const experiences: WorkspaceExperienceDefinition[] = [];
  const apis: WorkspaceExperienceApi[] = [];
  const workers: ExperienceWorker[] = [];
  await loadManifestAtomPack(monadPowerPack, {
    registerConnector: () => {},
    registerChannel: () => {},
    registerCommand: () => {},
    registerMessageType: () => {},
    registerSandbox: (l) => got.push(l),
    registerWorkspaceExperience: (experience) => experiences.push(experience),
    registerWorkspaceExperienceApi: (api) => apis.push(api),
    registerExperienceWorker: (worker) => workers.push(worker)
  });
  expect(got.map((l) => l.kind).sort()).toEqual(['docker', 'e2b']);
  expect(experiences.map((experience) => experience.id)).toEqual(['kanban']);
  expect(apis.map((api) => api.experienceId)).toEqual(['kanban']);
  expect(workers.map((worker) => worker.experienceId)).toEqual(['kanban']);
});
