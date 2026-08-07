import type { ProjectExperienceView } from '#/features/workplace/experiences/types';

import { expect, test } from 'bun:test';
import { WorkplaceExperiencePermissionError } from '@monad/sdk-experience';

import { restrictProjectExperienceView } from '#/features/workplace/experiences/restrict-view';

function hostView(calls: string[]): ProjectExperienceView {
  return {
    embedded: false,
    runtime: {
      actions: {
        addProjectMember: async () => {
          calls.push('addProjectMember');
        },
        loadOlder: () => {
          calls.push('loadOlder');
          return true;
        },
        pauseAll: () => calls.push('pauseAll'),
        removeProjectMember: async () => {
          calls.push('removeProjectMember');
        },
        resolveApproval: (requestId, decision) => calls.push(`resolveApproval:${requestId}:${decision}`),
        sendDirective: () => {
          calls.push('sendDirective');
        },
        sendMeshAgentInput: async () => {
          calls.push('sendMeshAgentInput');
        },
        stopMeshAgent: async () => {
          calls.push('stopMeshAgent');
        },
        switchExperience: (id) => calls.push(`switchExperience:${id}`),
        updateProjectMemberSettings: async () => {
          calls.push('updateProjectMemberSettings');
        }
      },
      snapshot: {
        activeProjectId: null,
        activeSessionId: null,
        availableProjectMembers: [],
        modelProfiles: [],
        paused: false,
        projectId: 'prj_1',
        projectMembers: [],
        projects: [],
        workdir: {}
      }
    }
  };
}

test('an experience without the approval permission cannot resolve an approval through the host view', () => {
  const calls: string[] = [];
  const restricted = restrictProjectExperienceView(hostView(calls), ['project.sessions.read']);

  expect(() => restricted.runtime.actions.resolveApproval('req_1', 'approve')).toThrow(
    WorkplaceExperiencePermissionError
  );
  restricted.runtime.actions.loadOlder();

  expect(calls).toEqual(['loadOlder']);
});

test('the restricted view keeps the rest of the host view and its snapshot intact', () => {
  const calls: string[] = [];
  const view = hostView(calls);
  const restricted = restrictProjectExperienceView(view, ['project.approvals.resolve']);

  restricted.runtime.actions.resolveApproval('req_2', 'reject');

  expect(restricted.embedded).toBe(false);
  expect(restricted.runtime.snapshot).toBe(view.runtime.snapshot);
  expect(calls).toEqual(['resolveApproval:req_2:reject']);
});

test('an experience registered with no permissions gets no management actions', () => {
  const calls: string[] = [];
  const restricted = restrictProjectExperienceView(hostView(calls), undefined);

  expect(() => restricted.runtime.actions.pauseAll()).toThrow(WorkplaceExperiencePermissionError);
  expect(() => restricted.runtime.actions.sendDirective('go')).toThrow(WorkplaceExperiencePermissionError);
  restricted.runtime.actions.switchExperience('chat-room');

  expect(calls).toEqual(['switchExperience:chat-room']);
});
