import type { WorkplaceExperiencePermission } from '@monad/protocol';
import type { WorkplaceExperienceActions } from '../../src/runtime.ts';

import { expect, test } from 'bun:test';

import {
  isWorkplaceExperienceActionGranted,
  restrictWorkplaceExperienceActions,
  WORKPLACE_EXPERIENCE_ACTION_PERMISSIONS,
  WorkplaceExperiencePermissionError
} from '../../src/index.ts';

function recordingActions(calls: string[]): WorkplaceExperienceActions {
  return {
    addProjectMember: async (type, name) => {
      calls.push(`addProjectMember:${type}:${name}`);
    },
    loadOlder: () => {
      calls.push('loadOlder');
      return true;
    },
    openProjectSession: (sessionId) => calls.push(`openProjectSession:${sessionId}`),
    pauseAll: () => calls.push('pauseAll'),
    removeProjectMember: async (id) => {
      calls.push(`removeProjectMember:${id}`);
    },
    resolveApproval: (requestId, decision) => calls.push(`resolveApproval:${requestId}:${decision}`),
    sendDirective: () => {
      calls.push('sendDirective');
    },
    sendMeshAgentInput: async (id, input) => {
      calls.push(`sendMeshAgentInput:${id}:${input}`);
    },
    stopMeshAgent: async (id) => {
      calls.push(`stopMeshAgent:${id}`);
    },
    switchExperience: (id) => calls.push(`switchExperience:${id}`),
    updateProjectMemberSettings: async (id) => {
      calls.push(`updateProjectMemberSettings:${id}`);
    }
  };
}

test('an ungranted action throws its required permission instead of reaching the host', () => {
  const calls: string[] = [];
  const restricted = restrictWorkplaceExperienceActions(recordingActions(calls), ['project.sessions.read']);

  expect(() => restricted.resolveApproval('req_1', 'approve')).toThrow(WorkplaceExperiencePermissionError);
  try {
    restricted.pauseAll();
    throw new Error('pauseAll should have been denied');
  } catch (err) {
    expect(err).toBeInstanceOf(WorkplaceExperiencePermissionError);
    expect((err as WorkplaceExperiencePermissionError).permission).toBe('project.agents.control');
    expect((err as WorkplaceExperiencePermissionError).action).toBe('pauseAll');
  }
  expect(calls).toEqual([]);
});

test('a granted action forwards its arguments to the host untouched', () => {
  const calls: string[] = [];
  const restricted = restrictWorkplaceExperienceActions(recordingActions(calls), [
    'project.sessions.read',
    'project.approvals.resolve'
  ]);

  restricted.loadOlder();
  restricted.resolveApproval('req_7', 'reject');

  expect(calls).toEqual(['loadOlder', 'resolveApproval:req_7:reject']);
});

test('host navigation stays callable with no permissions granted', () => {
  const calls: string[] = [];
  const restricted = restrictWorkplaceExperienceActions(recordingActions(calls), []);

  restricted.switchExperience('chat-room');
  restricted.openProjectSession?.('ses_a');

  expect(calls).toEqual(['switchExperience:chat-room', 'openProjectSession:ses_a']);
});

test('member management is denied per operation, not as one bundle', () => {
  const calls: string[] = [];
  const restricted = restrictWorkplaceExperienceActions(recordingActions(calls), ['project.members.invite']);

  void restricted.addProjectMember('mesh-agent', 'codex');
  expect(() => restricted.removeProjectMember('mem_1')).toThrow(WorkplaceExperiencePermissionError);
  expect(() => restricted.updateProjectMemberSettings('mem_1', {})).toThrow(WorkplaceExperiencePermissionError);

  expect(calls).toEqual(['addProjectMember:mesh-agent:codex']);
});

test('every classified action reports the same grant decision the restriction applies', () => {
  const granted: WorkplaceExperiencePermission[] = ['project.sessions.send'];
  const decisions = Object.keys(WORKPLACE_EXPERIENCE_ACTION_PERMISSIONS).map(
    (key) =>
      `${key}:${isWorkplaceExperienceActionGranted(key as keyof WorkplaceExperienceActions, granted) ? 'allow' : 'deny'}`
  );

  expect(decisions.toSorted()).toEqual([
    'addProjectMember:deny',
    'loadOlder:deny',
    'openProjectSession:allow',
    'pauseAll:deny',
    'removeProjectMember:deny',
    'resolveApproval:deny',
    'sendDirective:allow',
    'sendMeshAgentInput:allow',
    'stopMeshAgent:deny',
    'switchExperience:allow',
    'updateProjectMemberSettings:deny'
  ]);
});
