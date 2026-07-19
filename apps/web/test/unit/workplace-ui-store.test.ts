import { expect, test } from 'bun:test';

import { useWorkplaceUiStore } from '../../src/features/workplace/workplace-ui-store.ts';

test('workplace UI store owns session settings panel state', () => {
  useWorkplaceUiStore.getState().closeSessionSettings();

  useWorkplaceUiStore.getState().openSessionSettings('project-1');
  expect(useWorkplaceUiStore.getState().sessionSettings).toEqual({
    projectId: 'project-1'
  });

  useWorkplaceUiStore.getState().closeSessionSettings();
});

test('workplace UI store keeps session settings and member settings separate', () => {
  useWorkplaceUiStore.getState().closeSessionSettings();
  useWorkplaceUiStore.getState().closeProjectMemberSettings();

  useWorkplaceUiStore.getState().openSessionSettings('project-1');
  useWorkplaceUiStore.getState().openProjectMemberSettings('project-1', 'mesh-agent:codex');
  expect(useWorkplaceUiStore.getState().sessionSettings).toEqual({
    projectId: 'project-1'
  });
  expect(useWorkplaceUiStore.getState().projectMemberSettings).toEqual({
    projectId: 'project-1',
    memberId: 'mesh-agent:codex'
  });

  useWorkplaceUiStore.getState().closeSessionSettings();
  useWorkplaceUiStore.getState().closeProjectMemberSettings();
});
