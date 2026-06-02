import type { RegisteredWorkplaceExperience } from '../../../src/handlers/atom-pack/atom-pack-registry.ts';

import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWorkplaceExperienceSnapshot } from '../../../src/handlers/atom-pack/atom-pack-content.ts';

const created: string[] = [];

async function packRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'monad-workplace-experience-'));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test('workplace experience snapshot resolves serviceable pack-relative web component entries', async () => {
  const dir = await packRoot();
  await mkdir(join(dir, 'canvas-pack', 'dist'), { recursive: true });
  await writeFile(join(dir, 'canvas-pack', 'dist', 'canvas.js'), 'export {};');

  const experiences: RegisteredWorkplaceExperience[] = [
    {
      atomPackId: 'canvas-pack',
      id: 'canvas',
      permissions: ['project.sessions.read'],
      title: 'Canvas',
      entry: { type: 'web-component', module: './dist/canvas.js', tagName: 'monad-canvas' }
    }
  ];

  const snapshot = await createWorkplaceExperienceSnapshot(dir, experiences);

  expect(snapshot.experiences).toEqual([
    {
      id: 'canvas',
      title: 'Canvas',
      // The public projection carries the stamped grants — the Web host restricts the experience's
      // action surface from them.
      permissions: ['project.sessions.read'],
      entry: {
        type: 'web-component',
        module: '/v1/atoms/canvas-pack/assets/dist/canvas.js',
        tagName: 'monad-canvas'
      }
    }
  ]);
});

test('workplace experience snapshot warns and skips unserviceable web component entries', async () => {
  const dir = await packRoot();

  const experiences: RegisteredWorkplaceExperience[] = [
    {
      atomPackId: 'missing-pack',
      id: 'missing',
      permissions: [],
      title: 'Missing',
      entry: { type: 'web-component', module: './dist/missing.js', tagName: 'missing-canvas' }
    },
    {
      atomPackId: 'bad-pack',
      id: 'bad',
      permissions: [],
      title: 'Bad',
      entry: { type: 'web-component', module: '../bad.js', tagName: 'bad-canvas' }
    }
  ];

  const snapshot = await createWorkplaceExperienceSnapshot(dir, experiences);

  expect(snapshot.warnings).toEqual([
    { experienceId: 'missing', error: 'Atom Pack asset not found: missing-pack/./dist/missing.js' },
    { experienceId: 'bad', error: 'invalid web-component module path' }
  ]);
});

test('a reinstalled pack serves its web component under a new URL', async () => {
  const dir = await packRoot();
  await mkdir(join(dir, 'canvas-pack', 'dist'), { recursive: true });
  await writeFile(join(dir, 'canvas-pack', 'dist', 'canvas.js'), 'export {};');
  const experiences: RegisteredWorkplaceExperience[] = [
    {
      atomPackId: 'canvas-pack',
      id: 'canvas',
      permissions: [],
      title: 'Canvas',
      entry: { type: 'web-component', module: './dist/canvas.js', tagName: 'monad-canvas' }
    }
  ];
  const installRecord = join(dir, 'canvas-pack', '.install.json');
  const moduleUrl = async (): Promise<string> => {
    const snapshot = await createWorkplaceExperienceSnapshot(dir, experiences);
    const entry = snapshot.experiences[0]?.entry;
    return entry?.type === 'web-component' ? entry.module : '';
  };

  await writeFile(installRecord, JSON.stringify({ sourceKind: 'local', integrity: 'sha256-1111111111111111' }));
  const before = await moduleUrl();
  await writeFile(installRecord, JSON.stringify({ sourceKind: 'local', integrity: 'sha256-2222222222222222' }));
  const after = await moduleUrl();

  expect(before).toBe('/v1/atoms/canvas-pack/assets/dist/canvas.js?v=111111111111');
  expect(after).toBe('/v1/atoms/canvas-pack/assets/dist/canvas.js?v=222222222222');
});

test('a browser module that breaks the artifact contract is warned about and not served', async () => {
  const dir = await packRoot();
  await mkdir(join(dir, 'canvas-pack', 'dist'), { recursive: true });
  await writeFile(join(dir, 'canvas-pack', 'dist', 'canvas.js'), "import { readFile } from 'node:fs';\n");

  const snapshot = await createWorkplaceExperienceSnapshot(dir, [
    {
      atomPackId: 'canvas-pack',
      id: 'canvas',
      permissions: [],
      title: 'Canvas',
      entry: { type: 'web-component', module: './dist/canvas.js', tagName: 'monad-canvas' }
    }
  ]);

  expect(snapshot).toEqual({
    experiences: [],
    warnings: [{ experienceId: 'canvas', error: 'imports a Node or Bun builtin, which cannot resolve in a browser' }]
  });
});
