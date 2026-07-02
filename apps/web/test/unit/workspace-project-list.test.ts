import type { WorkplaceProject } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { buildWorkspaceProjects } from '../../lib/workspace-sessions.ts';

const project = (id: string, title: string): WorkplaceProject =>
  ({
    id,
    title,
    ownerPrincipalId: 'prn_test',
    state: 'active',
    archived: false,
    origin: { surface: 'web', client: 'workplace', transport: 'http', writableBy: ['http'], branchableBy: ['http'] },
    cwd: undefined,
    createdAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z'
  }) as WorkplaceProject;

test('workspace project list keeps duplicate project names as separate projects', () => {
  expect(buildWorkspaceProjects([project('prj_first', 'demo'), project('prj_second', 'demo')])).toEqual([
    { id: 'prj_first', name: 'demo', cwd: undefined },
    { id: 'prj_second', name: 'demo', cwd: undefined }
  ]);
});
