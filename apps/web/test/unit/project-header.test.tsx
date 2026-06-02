import { setupDomTestEnvironment } from '../dom-test-env';

setupDomTestEnvironment();

import type { MonadClient } from '@monad/client';

import { expect, mock, test } from 'bun:test';
import { createMonadStore } from '@monad/client-rtk';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';

import { ProjectHeader } from '../../src/features/workplace/project-shell/ProjectHeader';

test('project session header shows its breadcrumb and member controls', async () => {
  const onAddMember = mock(() => {});
  const store = createMonadStore({ client: {} as MonadClient });
  render(
    <Provider store={store}>
      <ProjectHeader
        onAddMember={onAddMember}
        project={
          {
            activeSessionId: 'ses_100000000000',
            projectId: 'prj_100000000000',
            projects: [{ id: 'prj_100000000000', name: 'Monad', active: true }],
            projectSessions: [{ id: 'ses_100000000000', title: 'Header work' }],
            sessionMembers: [{ member: { id: 'pmem_1' } }, { member: { id: 'pmem_2' } }],
            source: { meshAgentState: undefined },
            workdir: { path: undefined }
          } as never
        }
      />
    </Provider>
  );

  const breadcrumb = screen.getByLabelText('Project and session');
  expect({
    headerClass: breadcrumb.closest('header')?.className,
    text: breadcrumb.textContent
  }).toEqual({
    headerClass: expect.stringContaining('panel-shell-header'),
    text: 'Monad/Header work'
  });
  expect(screen.getByLabelText('2 members in this session').textContent).toContain('2');
  const addMember = screen.getByRole('button', { name: 'Add member' });
  expect(addMember.className).toContain('text-muted-foreground');
  await userEvent.click(addMember);
  expect(onAddMember.mock.calls).toEqual([[]]);
});
