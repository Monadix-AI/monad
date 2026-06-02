import type { SessionMemberBinding, WorkplaceProjectMemberSettings } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { resolveExperienceProjectMembers } from '../../src/workplace-experiences/experience/project-members.ts';

const AT = '2026-07-18T08:00:00.000Z';

function memberEntry(over: {
  id: string;
  profileId: string;
  displayName: string;
  type?: 'mesh-agent' | 'acp';
  launchOverrides?: WorkplaceProjectMemberSettings;
}): SessionMemberBinding {
  return {
    member: {
      id: over.id,
      projectId: 'prj_test000000001',
      profileId: over.profileId,
      type: over.type ?? 'mesh-agent',
      displayName: over.displayName,
      customPrompt: null,
      launchOverrides: over.launchOverrides ?? {},
      workingDirectoryOverride: null,
      lifecycle: 'enabled',
      createdAt: AT,
      updatedAt: AT
    },
    binding: {
      sessionId: 'ses_active',
      projectMemberId: over.id,
      lastDeliveredSeq: 0,
      lastVisibleSeq: 0,
      currentNativeRuntimeSessionId: null,
      lifecycle: 'active',
      lastHealth: null,
      createdAt: AT,
      updatedAt: AT
    }
  };
}

test('an invited member recovers its mesh-agent name from the matching template', () => {
  const [view] = resolveExperienceProjectMembers({
    activeSessionId: 'ses_active',
    memberTemplates: [{ id: 'tpl_codex', type: 'mesh-agent', name: 'codex', displayName: 'Codex' }],
    sessionMembers: [memberEntry({ id: 'pmem_codex_1', profileId: 'tpl_codex', displayName: 'Codex' })]
  });
  expect(view).toEqual({
    id: 'pmem_codex_1',
    type: 'mesh-agent',
    name: 'codex',
    templateName: 'codex',
    instanceId: 'pmem_codex_1',
    displayName: 'Codex',
    joinedAt: AT
  });
});

test('an ad-hoc spawned member uses its profileId as the name (no template lookup)', () => {
  const [view] = resolveExperienceProjectMembers({
    activeSessionId: 'ses_active',
    memberTemplates: [],
    sessionMembers: [memberEntry({ id: 'pmem_gemini_1', profileId: 'gemini', displayName: 'Ad hoc Gemini' })]
  });
  expect(view).toEqual({
    id: 'pmem_gemini_1',
    type: 'mesh-agent',
    name: 'gemini',
    templateName: 'gemini',
    instanceId: 'pmem_gemini_1',
    displayName: 'Ad hoc Gemini',
    joinedAt: AT
  });
});

test('two members from one template keep distinct identities that both resolve to the template name', () => {
  const views = resolveExperienceProjectMembers({
    activeSessionId: 'ses_active',
    memberTemplates: [{ id: 'tpl_codex', type: 'mesh-agent', name: 'codex', displayName: 'Codex' }],
    sessionMembers: [
      memberEntry({ id: 'pmem_codex_a', profileId: 'tpl_codex', displayName: 'Reviewer A' }),
      memberEntry({ id: 'pmem_codex_b', profileId: 'tpl_codex', displayName: 'Reviewer B' })
    ]
  });
  expect(views.map((view) => ({ id: view.id, name: view.name, displayName: view.displayName }))).toEqual([
    { id: 'pmem_codex_a', name: 'codex', displayName: 'Reviewer A' },
    { id: 'pmem_codex_b', name: 'codex', displayName: 'Reviewer B' }
  ]);
});

test('renaming the source template changes only the derived view name, not the canonical identity', () => {
  const entry = memberEntry({ id: 'pmem_codex_1', profileId: 'tpl_codex', displayName: 'Codex' });
  const [before] = resolveExperienceProjectMembers({
    activeSessionId: 'ses_active',
    memberTemplates: [{ id: 'tpl_codex', type: 'mesh-agent', name: 'codex', displayName: 'Codex' }],
    sessionMembers: [entry]
  });
  const [after] = resolveExperienceProjectMembers({
    activeSessionId: 'ses_active',
    memberTemplates: [{ id: 'tpl_codex', type: 'mesh-agent', name: 'codex-next', displayName: 'Codex' }],
    sessionMembers: [entry]
  });
  expect({ name: before?.name, templateName: before?.templateName }).toEqual({ name: 'codex', templateName: 'codex' });
  expect({ name: after?.name, templateName: after?.templateName }).toEqual({
    name: 'codex-next',
    templateName: 'codex-next'
  });
  // The canonical identity and binding-derived join timestamp are unchanged by the template rename.
  expect({ id: after?.id, instanceId: after?.instanceId, joinedAt: after?.joinedAt }).toEqual({
    id: 'pmem_codex_1',
    instanceId: 'pmem_codex_1',
    joinedAt: AT
  });
});

test('active chat projects the session roster instead of newer project templates', () => {
  // The session's active binding for `pmem_fable` is projected even though the project's memberTemplates
  // have moved on to `pmem_opus`. The mesh-agent name is recovered from the member's Profile reference via
  // memberTemplates; here fable's source template is already gone, so `name` falls back to the profileId
  // until reconcile leaves the orphaned member. Loop/connection state is no longer carried on the wire.
  expect(
    resolveExperienceProjectMembers({
      activeSessionId: 'ses_active',
      memberTemplates: [
        {
          id: 'pmem_opus',
          type: 'mesh-agent',
          name: 'claude-code',
          displayName: 'Opus',
          settings: { modelId: 'opus' }
        }
      ],
      sessionMembers: [
        {
          member: {
            id: 'pmem_fable',
            projectId: 'prj_test000000001',
            profileId: 'pmem_fable',
            type: 'mesh-agent',
            displayName: 'Fable',
            customPrompt: null,
            launchOverrides: { modelId: 'fable' },
            workingDirectoryOverride: null,
            lifecycle: 'enabled',
            createdAt: '2026-07-18T08:00:00.000Z',
            updatedAt: '2026-07-18T08:00:00.000Z'
          },
          binding: {
            sessionId: 'ses_active',
            projectMemberId: 'pmem_fable',
            lastDeliveredSeq: 0,
            lastVisibleSeq: 0,
            currentNativeRuntimeSessionId: null,
            lifecycle: 'active',
            lastHealth: null,
            createdAt: '2026-07-18T08:00:00.000Z',
            updatedAt: '2026-07-18T08:00:00.000Z'
          }
        }
      ]
    })
  ).toEqual([
    {
      id: 'pmem_fable',
      type: 'mesh-agent',
      name: 'pmem_fable',
      templateName: 'pmem_fable',
      instanceId: 'pmem_fable',
      displayName: 'Fable',
      settings: { modelId: 'fable' },
      joinedAt: '2026-07-18T08:00:00.000Z'
    }
  ]);
});
