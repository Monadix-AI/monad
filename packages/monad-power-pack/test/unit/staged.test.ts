import type {
  ExperienceWorker,
  SandboxLauncher,
  WorkplaceExperienceApi,
  WorkplaceExperienceDefinition
} from '@monad/sdk-atom';

import { expect, test } from 'bun:test';
import { parseAtomPackManifest } from '@monad/protocol';
import { loadManifestAtomPack } from '@monad/sdk-atom';

import manifestJson from '../../atom-pack.json' with { type: 'json' };
import defaultAtomPack, { monadPowerPack } from '../../src/index.ts';

test('the runtime pack uses atom-pack.json as its exact manifest contract', () => {
  expect(monadPowerPack.manifest).toEqual(parseAtomPackManifest(manifestJson));
});

test('the default runtime entry registers the real pack through the gated loader', async () => {
  const got: SandboxLauncher[] = [];
  const experiences: WorkplaceExperienceDefinition[] = [];
  const apis: WorkplaceExperienceApi[] = [];
  const workers: ExperienceWorker[] = [];
  await loadManifestAtomPack(defaultAtomPack, {
    registerChannel: () => {},
    registerCommand: () => {},
    registerMessageType: () => {},
    registerSandbox: (l) => got.push(l),
    registerWorkplaceExperience: (experience) => experiences.push(experience),
    registerWorkplaceExperienceApi: (api) => apis.push(api),
    registerExperienceWorker: (worker) => workers.push(worker)
  });
  expect(got.map((l) => l.kind).sort()).toEqual(['docker', 'e2b']);
  expect(experiences.map((experience) => experience.id)).toEqual(['kanban']);
  expect(apis.map((api) => api.experienceId)).toEqual(['kanban']);
  expect(workers.map((worker) => worker.experienceId)).toEqual(['kanban']);
});
