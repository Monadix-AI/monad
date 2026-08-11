import { expect, test } from 'bun:test';
import { entityAvatarUrl, meshAgentProjectMemberAvatarSeed } from '@monad/protocol';

import {
  directSessionMemberCandidates,
  directSessionMemberDraft,
  sessionMemberAvatar,
  sessionProjectMemberDisplayName,
  shouldDeferSessionMemberRoster
} from '../../src/features/workplace/project-shell/SessionMembersSection';

test('direct session members expose provider-spawn candidates only', () => {
  const candidates = [
    { id: 'mesh-agent:codex', type: 'mesh-agent', name: 'codex' },
    { id: 'pmem_acp_researcher', type: 'acp', name: 'researcher' }
  ] as never;

  expect(directSessionMemberCandidates(candidates).map(({ id, name, type }) => ({ id, name, type }))).toEqual([
    { id: 'mesh-agent:codex', type: 'mesh-agent', name: 'codex' }
  ]);
});

test('direct Monad session members persist the configured agent name instead of the internal profile id', () => {
  expect(
    directSessionMemberDraft({
      id: 'mesh-agent:monad--agt_eAmWnO0FDkBJ',
      type: 'mesh-agent',
      name: 'monad--agt_eAmWnO0FDkBJ',
      label: 'Default Dev Agent'
    } as never)
  ).toEqual({ displayName: 'Default Dev Agent' });
});

test('session project members retain initials with the project-scoped avatar', () => {
  const participant = {
    av: 'RE',
    avatarUrl: '/avatars/researcher.svg',
    icon: 'codex',
    id: 'pmem_researcher',
    kind: 'agent',
    name: 'Researcher',
    presence: 'online',
    role: 'CLI',
    tag: 'Codex'
  } as never;

  const projectId = 'prj_100000000000';
  const displayName = 'Researcher';
  const expected = {
    av: 'RE',
    avatarUrl: entityAvatarUrl(meshAgentProjectMemberAvatarSeed(projectId, displayName), 'bottts'),
    name: displayName
  } as const;

  expect(sessionMemberAvatar({ avatarStyle: 'bottts', displayName, participant, projectId })).toEqual(expected);
});

test('project members derive the same project-scoped avatar outside a session participant', () => {
  const projectId = 'prj_100000000000';
  const displayName = 'Session reviewer';
  const providerIcon = { path: 'M0 0h24v24H0z', title: 'Codex adapter' };

  expect(
    sessionMemberAvatar({
      avatarStyle: 'bottts',
      candidate: { icon: 'incorrect-local-override', providerIcon } as never,
      displayName,
      projectId
    })
  ).toEqual({
    avatarUrl: entityAvatarUrl(meshAgentProjectMemberAvatarSeed(projectId, displayName), 'bottts'),
    name: displayName,
    providerIcon
  });
});

test('Monad project members resolve their configured agent name instead of their internal id', () => {
  expect(
    sessionProjectMemberDisplayName({
      candidate: { label: 'Default Dev Agent' } as never,
      fallbackName: 'monad--agt_eAmWnO0FDkBJ',
      template: { name: 'monad--agt_eAmWnO0FDkBJ' } as never
    })
  ).toBe('Default Dev Agent');
});

test('a newly selected session defers its roster until data for that session arrives', () => {
  const activeSessionId = 'ses_new000000000' as never;

  expect([
    shouldDeferSessionMemberRoster({ activeSessionId, hasCurrentData: false, isFetching: true, isLoading: false }),
    shouldDeferSessionMemberRoster({ activeSessionId, hasCurrentData: true, isFetching: true, isLoading: false }),
    shouldDeferSessionMemberRoster({
      activeSessionId: null,
      hasCurrentData: false,
      isFetching: false,
      isLoading: false
    })
  ]).toEqual([true, false, false]);
});
