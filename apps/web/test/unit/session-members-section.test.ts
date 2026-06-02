import { expect, test } from 'bun:test';
import { entityAvatarUrl, meshAgentProjectMemberAvatarSeed } from '@monad/protocol';

import {
  directSessionMemberCandidates,
  sessionMemberAvatar
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

test('session project members reuse the project participant avatar', () => {
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

  expect(
    sessionMemberAvatar({
      avatarStyle: 'bottts',
      displayName: 'Wrong fallback',
      participant,
      projectId: 'prj_100000000000'
    })
  ).toEqual(participant);
});

test('direct session members derive a session-only avatar from their configured name', () => {
  const projectId = 'prj_100000000000';
  const displayName = 'Session reviewer';

  expect(
    sessionMemberAvatar({
      avatarStyle: 'bottts',
      candidate: { icon: 'codex' } as never,
      displayName,
      projectId
    })
  ).toEqual({
    avatarUrl: entityAvatarUrl(meshAgentProjectMemberAvatarSeed(projectId, displayName), 'bottts'),
    icon: 'codex',
    name: displayName
  });
});
