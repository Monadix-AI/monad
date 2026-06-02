import { expect, test } from 'bun:test';

import {
  closestProjectDropBreakpoint,
  projectOrderDestination,
  readProjectDragId,
  writeProjectDragId
} from '#/features/shell/sidebar/project-order-drag-state';

test('project drop resolves list breakpoints to stable neighbors', () => {
  expect(projectOrderDestination(['a', 'b', 'c'], 'b', 'a')).toEqual({ beforeProjectId: 'a' });
  expect(projectOrderDestination(['a', 'b', 'c'], 'a', null)).toEqual({ afterProjectId: 'c' });
  expect(projectOrderDestination(['a', 'b', 'c'], 'b', 'c')).toBeNull();
});

test('project drop surface snaps the pointer to the nearest list breakpoint', () => {
  const breakpoints = [
    { beforeProjectId: 'a', y: 100 },
    { beforeProjectId: 'b', y: 200 },
    { beforeProjectId: null, y: 300 }
  ];

  expect([
    closestProjectDropBreakpoint(breakpoints, 125),
    closestProjectDropBreakpoint(breakpoints, 185),
    closestProjectDropBreakpoint(breakpoints, 270)
  ]).toEqual(['a', 'b', null]);
});

test('project drag binds its project id to the native drop transaction', () => {
  const values = new Map<string, string>();
  const transfer = {
    getData: (type: string) => values.get(type) ?? '',
    setData: (type: string, value: string) => values.set(type, value)
  };

  writeProjectDragId(transfer, 'prj_ABCDEF123456');

  expect({ values: Object.fromEntries(values), projectId: readProjectDragId(transfer) }).toEqual({
    values: {
      'application/x-monad-project-id': 'prj_ABCDEF123456',
      'text/plain': 'prj_ABCDEF123456'
    },
    projectId: 'prj_ABCDEF123456'
  });
});
