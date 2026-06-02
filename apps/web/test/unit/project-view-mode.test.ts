import { expect, test } from 'bun:test';

import {
  normalizeProjectViewMode,
  projectViewModeStorageKey
} from '../../src/features/workspace/use-project-view-mode';

test('project view mode storage key is scoped to the project', () => {
  expect(projectViewModeStorageKey({ projectId: 'prj_DEMO00000000' })).toBe('monad.projectViewMode:prj_DEMO00000000');
  expect(projectViewModeStorageKey({ projectId: null })).toBeNull();
});

test('legacy graph experience ids migrate to kanban', () => {
  expect(normalizeProjectViewMode('graphic-view')).toBe('kanban');
  expect(normalizeProjectViewMode('graph-view')).toBe('kanban');
  expect(normalizeProjectViewMode('chat-room')).toBe('chat-room');
});
