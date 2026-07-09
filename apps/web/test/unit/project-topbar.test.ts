import { expect, test } from 'bun:test';

import { projectTopBarBreadcrumbItems } from '../../src/features/workspace/ProjectTopBar';

test('project top bar breadcrumb includes the active session when available', () => {
  expect(projectTopBarBreadcrumbItems({ projectName: 'Mock Project', sessionTitle: 'Alpha session' })).toEqual([
    'Mock Project',
    'Alpha session'
  ]);
  expect(projectTopBarBreadcrumbItems({ projectName: 'Mock Project', sessionTitle: null })).toEqual(['Mock Project']);
  expect(projectTopBarBreadcrumbItems({ projectName: 'Mock Project', sessionTitle: '   ' })).toEqual(['Mock Project']);
});
