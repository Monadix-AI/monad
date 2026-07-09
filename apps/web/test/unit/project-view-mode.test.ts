import { expect, test } from 'bun:test';

import { projectViewModeStorageKey } from '../../src/features/workspace/use-project-view-mode';

test('project view mode storage key prefers the active project session', () => {
  expect(projectViewModeStorageKey({ projectId: 'prj_DEMO00000000', sessionId: 'ses_ALPHA0000000' })).toBe(
    'monad.projectViewMode.session:ses_ALPHA0000000'
  );
  expect(projectViewModeStorageKey({ projectId: 'prj_DEMO00000000', sessionId: null })).toBe(
    'monad.projectViewMode:prj_DEMO00000000'
  );
  expect(projectViewModeStorageKey({ projectId: null, sessionId: null })).toBeNull();
});
