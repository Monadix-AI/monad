import { expect, test } from 'bun:test';

import { useWorkplaceUiStore } from '../../src/features/workplace/workplace-ui-store.ts';

test('workplace UI store owns project settings panel state', () => {
  useWorkplaceUiStore.getState().closeProjectSettings();

  useWorkplaceUiStore.getState().openProjectSettings('project-1');
  expect(useWorkplaceUiStore.getState().projectSettings).toEqual({
    projectId: 'project-1'
  });

  useWorkplaceUiStore.getState().closeProjectSettings();
});

test('workplace UI store keeps project settings and member settings separate', () => {
  useWorkplaceUiStore.getState().closeProjectSettings();
  useWorkplaceUiStore.getState().closeProjectMemberSettings();

  useWorkplaceUiStore.getState().openProjectMemberSettings('project-1', 'external-agent:codex');
  expect(useWorkplaceUiStore.getState().projectMemberSettings).toEqual({
    projectId: 'project-1',
    memberId: 'external-agent:codex'
  });

  useWorkplaceUiStore.getState().closeProjectMemberSettings();
});
