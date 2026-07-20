import type { RegisteredWorkspaceExperience } from '../../../src/handlers/atom-pack/atom-pack-registry.ts';

import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWorkspaceExperienceSnapshot } from '../../../src/handlers/atom-pack/atom-pack-content.ts';

const created: string[] = [];

async function packRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'monad-workspace-experience-'));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test('workspace experience snapshot resolves serviceable pack-relative web component entries', async () => {
  const dir = await packRoot();
  await mkdir(join(dir, 'canvas-pack', 'dist'), { recursive: true });
  await writeFile(join(dir, 'canvas-pack', 'dist', 'canvas.js'), 'export {};');

  const experiences: RegisteredWorkspaceExperience[] = [
    {
      atomPackId: 'canvas-pack',
      id: 'canvas',
      title: 'Canvas',
      entry: { type: 'web-component', module: './dist/canvas.js', tagName: 'monad-canvas' }
    }
  ];

  const snapshot = await createWorkspaceExperienceSnapshot(dir, experiences);

  expect(snapshot.experiences).toEqual([
    {
      id: 'canvas',
      title: 'Canvas',
      entry: {
        type: 'web-component',
        module: '/v1/atoms/canvas-pack/assets/dist/canvas.js',
        tagName: 'monad-canvas'
      }
    }
  ]);
});

test('workspace experience snapshot warns and skips unserviceable web component entries', async () => {
  const dir = await packRoot();

  const experiences: RegisteredWorkspaceExperience[] = [
    {
      atomPackId: 'missing-pack',
      id: 'missing',
      title: 'Missing',
      entry: { type: 'web-component', module: './dist/missing.js', tagName: 'missing-canvas' }
    },
    {
      atomPackId: 'bad-pack',
      id: 'bad',
      title: 'Bad',
      entry: { type: 'web-component', module: '../bad.js', tagName: 'bad-canvas' }
    }
  ];

  const snapshot = await createWorkspaceExperienceSnapshot(dir, experiences);

  expect(snapshot.warnings).toEqual([
    { experienceId: 'missing', error: 'atom pack asset not found: missing-pack/./dist/missing.js' },
    { experienceId: 'bad', error: 'invalid web-component module path' }
  ]);
});
