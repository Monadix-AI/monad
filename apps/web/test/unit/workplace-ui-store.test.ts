import { expect, test } from 'bun:test';

import { useWorkplaceUiStore } from '../../features/workplace/workplace-ui-store.ts';

test('workplace UI store owns project settings panel state', () => {
  useWorkplaceUiStore.getState().closeProjectSettings();

  useWorkplaceUiStore.getState().openProjectSettings('project-1');
  expect(useWorkplaceUiStore.getState().projectSettings).toEqual({
    projectId: 'project-1'
  });

  useWorkplaceUiStore.getState().closeProjectSettings();
  expect(useWorkplaceUiStore.getState().projectSettings).toBeNull();
});

test('workplace UI store keeps project settings and member settings separate', () => {
  useWorkplaceUiStore.getState().closeProjectSettings();
  useWorkplaceUiStore.getState().closeProjectMemberSettings();

  useWorkplaceUiStore.getState().openProjectMemberSettings('project-1', 'native-cli:codex');
  expect(useWorkplaceUiStore.getState().projectSettings).toBeNull();
  expect(useWorkplaceUiStore.getState().projectMemberSettings).toEqual({
    projectId: 'project-1',
    memberId: 'native-cli:codex'
  });

  useWorkplaceUiStore.getState().closeProjectMemberSettings();
  expect(useWorkplaceUiStore.getState().projectMemberSettings).toBeNull();
});
