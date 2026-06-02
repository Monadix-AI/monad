import { setupDomTestEnvironment } from '../dom-test-env';

setupDomTestEnvironment();

import { expect, mock, test } from 'bun:test';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ProjectSettings } from '../../src/features/workplace/project-shell/ProjectSettings';

test('both project agent section refresh buttons request a catalog refresh', async () => {
  const refreshMeshAgentCatalog = mock(() => {});
  render(
    <ProjectSettings
      room={
        {
          addProjectMember: () => Promise.resolve(),
          availableProjectMembers: [],
          deleteProject: () => Promise.resolve(),
          membersLoading: false,
          membersRefreshing: false,
          projectId: 'prj_100000000000',
          projectMembers: [],
          projectParticipants: [],
          ready: true,
          refreshMeshAgentCatalog: refreshMeshAgentCatalog,
          removeProjectMember: () => Promise.resolve(),
          source: { project: { title: 'Catalog test' } },
          workdir: { path: undefined }
        } as never
      }
    />
  );

  const buttons = screen.getAllByRole('button', { name: 'Refresh' });
  for (const button of buttons) await userEvent.click(button);

  expect({ buttons: buttons.length, refreshes: refreshMeshAgentCatalog.mock.calls.length }).toEqual({
    buttons: 2,
    refreshes: 2
  });
});

test('project settings changes the experience shared by the project sessions', async () => {
  const onModeChange = mock((_mode: string) => {});
  render(
    <ProjectSettings
      experiences={[
        { id: 'chat-room', label: 'Project session', render: () => <div /> },
        { id: 'kanban', label: 'Kanban', render: () => <div /> }
      ]}
      mode="chat-room"
      onModeChange={onModeChange}
      room={
        {
          addProjectMember: () => Promise.resolve(),
          availableProjectMembers: [],
          deleteProject: () => Promise.resolve(),
          membersLoading: false,
          membersRefreshing: false,
          projectId: 'prj_100000000000',
          projectMembers: [],
          projectParticipants: [],
          ready: true,
          refreshMeshAgentCatalog: () => {},
          removeProjectMember: () => Promise.resolve(),
          source: { project: { title: 'Experience test' } },
          workdir: { path: undefined }
        } as never
      }
    />
  );

  const select = screen.getByRole('combobox', { name: 'Project experience' }) as HTMLSelectElement;
  await userEvent.selectOptions(select, 'kanban');

  expect(onModeChange.mock.calls).toEqual([['kanban']]);
});

test('project settings toggles automatic member invites for new sessions', async () => {
  const updateProjectAutoInviteMembers = mock((_checked: boolean) => Promise.resolve());
  render(
    <ProjectSettings
      room={
        {
          addProjectMember: () => Promise.resolve(),
          availableProjectMembers: [],
          deleteProject: () => Promise.resolve(),
          membersLoading: false,
          membersRefreshing: false,
          projectId: 'prj_100000000000',
          projectMembers: [],
          projectParticipants: [],
          ready: true,
          refreshMeshAgentCatalog: () => {},
          removeProjectMember: () => Promise.resolve(),
          source: { project: { title: 'Invite setting', autoInviteProjectMembers: true } },
          updateProjectAutoInviteMembers,
          workdir: { path: undefined }
        } as never
      }
    />
  );

  await userEvent.click(screen.getByRole('switch', { name: 'Add project members to new sessions' }));
  expect(updateProjectAutoInviteMembers.mock.calls).toEqual([[false]]);
});
