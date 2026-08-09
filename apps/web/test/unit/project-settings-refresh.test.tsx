import { setupDomTestEnvironment } from '../dom-test-env';

setupDomTestEnvironment();

import { expect, mock, test } from 'bun:test';
import { render, screen, waitFor } from '@testing-library/react';
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

test('project settings has no automatic member invite option', () => {
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
          source: { project: { title: 'Manual member setting' } },
          workdir: { path: undefined }
        } as never
      }
    />
  );

  expect(screen.queryByRole('switch', { name: 'Add project members to new sessions' })).toBeNull();
});

test('project settings confirms project member removal and updates the roster optimistically', async () => {
  let resolveRemoval: (() => void) | undefined;
  const removal = new Promise<void>((resolve) => {
    resolveRemoval = resolve;
  });
  const removeProjectMember = mock((_memberId: string) => removal);
  render(
    <ProjectSettings
      room={
        {
          addProjectMember: () => Promise.resolve(),
          availableProjectMembers: [
            { enabled: true, id: 'mesh-agent:codex', label: 'OpenAI Codex', name: 'codex', type: 'mesh-agent' }
          ],
          deleteProject: () => Promise.resolve(),
          membersLoading: false,
          membersRefreshing: false,
          projectId: 'prj_100000000000',
          projectMembers: [
            { id: 'pmem_session', type: 'mesh-agent', name: 'codex', displayName: 'Session member' },
            { id: 'pmem_template', type: 'mesh-agent', name: 'codex', displayName: 'Project-only member' }
          ],
          projectParticipants: [
            {
              id: 'pmem_session',
              kind: 'agent',
              name: 'Session member',
              presence: 'online',
              role: 'CLI',
              tag: 'Codex'
            }
          ],
          ready: true,
          refreshMeshAgentCatalog: () => {},
          removeProjectMember,
          source: { project: { title: 'Roster test' } },
          workdir: { path: undefined }
        } as never
      }
    />
  );

  expect({
    members: screen.getAllByRole('button', { name: 'Project member settings' }).length,
    projectOnlyMember: screen.getByText('Project-only member').textContent
  }).toEqual({ members: 2, projectOnlyMember: 'Project-only member' });
  await userEvent.click(
    screen.getAllByRole('button', { name: 'Remove CLI member from this project' })[1] as HTMLElement
  );
  expect({
    calls: removeProjectMember.mock.calls,
    member: screen.getByText('Project-only member').textContent
  }).toEqual({
    calls: [],
    member: 'Project-only member'
  });

  await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
  expect(removeProjectMember.mock.calls).toEqual([['pmem_template']]);
  // behavior-ok: confirming removal hides the project member before the request settles
  expect(screen.queryByText('Project-only member')).toBeNull();
  resolveRemoval?.();
});

test('project settings restores an optimistically removed member when removal fails', async () => {
  let rejectRemoval: ((error: Error) => void) | undefined;
  const removal = new Promise<void>((_resolve, reject) => {
    rejectRemoval = reject;
  });
  const removeProjectMember = mock((_memberId: string) => removal);
  render(
    <ProjectSettings
      room={
        {
          addProjectMember: () => Promise.resolve(),
          availableProjectMembers: [
            { enabled: true, id: 'mesh-agent:codex', label: 'OpenAI Codex', name: 'codex', type: 'mesh-agent' }
          ],
          deleteProject: () => Promise.resolve(),
          membersLoading: false,
          membersRefreshing: false,
          projectId: 'prj_100000000000',
          projectMembers: [{ id: 'pmem_template', type: 'mesh-agent', name: 'codex', displayName: 'Restored member' }],
          projectParticipants: [],
          ready: true,
          refreshMeshAgentCatalog: () => {},
          removeProjectMember,
          source: { project: { title: 'Rollback test' } },
          workdir: { path: undefined }
        } as never
      }
    />
  );

  await userEvent.click(screen.getByRole('button', { name: 'Remove CLI member from this project' }));
  await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
  // behavior-ok: the failed request is held so the optimistic removal is observable before rollback
  expect(screen.queryByText('Restored member')).toBeNull();
  rejectRemoval?.(new Error('remove failed'));
  await waitFor(() => expect(screen.getByText('Restored member').textContent).toBe('Restored member'));
  expect(removeProjectMember.mock.calls).toEqual([['pmem_template']]);
});

test('project settings renders provider logos supplied by agent adapters', () => {
  const adapterPath = 'M3 3h18v18H3z';
  render(
    <ProjectSettings
      room={
        {
          addProjectMember: () => Promise.resolve(),
          availableProjectMembers: [
            {
              enabled: true,
              id: 'mesh-agent:codex',
              label: 'OpenAI Codex',
              name: 'codex',
              provider: 'codex',
              providerIcon: { title: 'Codex adapter', path: adapterPath },
              type: 'mesh-agent'
            }
          ],
          deleteProject: () => Promise.resolve(),
          membersLoading: false,
          membersRefreshing: false,
          projectId: 'prj_100000000000',
          projectMembers: [],
          projectParticipants: [],
          ready: true,
          refreshMeshAgentCatalog: () => {},
          removeProjectMember: () => Promise.resolve(),
          source: { project: { title: 'Adapter logo test' } },
          workdir: { path: undefined }
        } as never
      }
    />
  );

  const providerRow = screen.getByText('OpenAI Codex').closest('.project-provider-row');
  expect(providerRow?.querySelector(`svg path[d="${adapterPath}"]`)?.getAttribute('d')).toBe(adapterPath);
});
