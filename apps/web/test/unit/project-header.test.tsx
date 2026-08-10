import { setupDomTestEnvironment } from '../dom-test-env';

setupDomTestEnvironment();

import type { MonadClient } from '@monad/client';

import { expect, mock, test } from 'bun:test';
import { createMonadStore } from '@monad/client-rtk';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'react-redux';

import { ProjectHeader } from '../../src/features/workplace/project-shell/ProjectHeader';

test('project session header opens the existing member flow', async () => {
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
            sessionMembers: [
              { member: { id: 'pmem_1', displayName: 'Research lead', profileId: 'codex-main' } },
              { member: { id: 'pmem_2', displayName: 'Reviewer', profileId: 'claude-review' } }
            ],
            projectParticipants: [
              {
                id: 'pmem_1',
                av: 'RL',
                avatarUrl: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
                name: 'Research lead',
                tag: 'Codex',
                icon: 'codex'
              },
              {
                id: 'pmem_2',
                av: 'RV',
                avatarUrl: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
                name: 'Reviewer',
                tag: 'Claude',
                icon: 'claude-code'
              }
            ],
            source: { meshAgentIcons: new Map(), meshAgentState: undefined, meshAgentTags: new Map() },
            workdir: { path: undefined }
          } as never
        }
      />
    </Provider>
  );

  const addMember = screen.getByRole('button', { name: 'Add member' });
  await userEvent.click(addMember);
  expect(onAddMember.mock.calls).toEqual([[]]);

  await userEvent.hover(screen.getByRole('button', { name: '2 members in this session' }));
  const memberList = await screen.findByRole('list', { name: 'Session members' });
  expect(
    within(memberList)
      .getAllByRole('listitem')
      .map((item) => item.textContent)
  ).toEqual(['RLResearch leadOpenAI Codex', 'RVReviewerClaude Code']);
  // behavior-ok: hovering the member count reveals a bounded roster that scrolls inside the popover.
  expect(memberList.className).toContain('max-h-72 list-none overflow-y-auto overscroll-contain');
});

test('project session header renames the active session inline', async () => {
  const renameSession = mock((_sessionId: string, _title: string) => {});
  const store = createMonadStore({ client: {} as MonadClient });
  render(
    <Provider store={store}>
      <ProjectHeader
        onAddMember={() => {}}
        project={
          {
            activeSessionId: 'ses_100000000000',
            projectId: 'prj_100000000000',
            projects: [{ id: 'prj_100000000000', name: 'Monad', active: true }],
            projectSessions: [{ id: 'ses_100000000000', title: 'Header work' }],
            renameSession,
            sessionMembers: [],
            projectParticipants: [],
            source: { meshAgentIcons: new Map(), meshAgentState: undefined, meshAgentTags: new Map() },
            workdir: { path: undefined }
          } as never
        }
      />
    </Provider>
  );

  await userEvent.click(screen.getByRole('button', { name: 'Rename session' }));
  const input = screen.getByRole('textbox', { name: 'Rename session' });
  await userEvent.clear(input);
  await userEvent.type(input, 'Project title{Enter}');

  expect(renameSession.mock.calls).toEqual([['ses_100000000000', 'Project title']]);
});
