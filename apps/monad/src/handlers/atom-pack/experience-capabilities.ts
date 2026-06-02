import type {
  ExperienceStateStore,
  ExperienceWorkerScheduler,
  ProjectMemberOperations,
  ProjectSessionOperations,
  WorkplaceExperienceApiContext,
  WorkplaceExperiencePermission
} from '@monad/sdk-atom';
import type { InteractionService } from '#/interactions/service.ts';

export interface ExperienceCapabilityDeps {
  state: {
    forPack(atomPackId: string): ExperienceStateStore;
  };
  projectSessions: {
    operations(): ProjectSessionOperations;
  };
  projectMembers: {
    operations(): ProjectMemberOperations;
  };
  interactions: Pick<InteractionService, 'request'>;
  workerScheduler: {
    forExperience(atomPackId: string, experienceId: string): ExperienceWorkerScheduler;
  };
}

function permissionGuard(permissions: readonly WorkplaceExperiencePermission[]) {
  const granted = new Set(permissions);
  return (permission: WorkplaceExperiencePermission): void => {
    if (!granted.has(permission)) throw new Error(`workplace experience permission required: ${permission}`);
  };
}

export function createWorkplaceExperienceApiContext(input: {
  atomPackId: string;
  experienceId: string;
  permissions: readonly WorkplaceExperiencePermission[];
  deps: ExperienceCapabilityDeps;
}): WorkplaceExperienceApiContext {
  const requirePermission = permissionGuard(input.permissions);
  const state = input.deps.state.forPack(input.atomPackId);
  const sessions = input.deps.projectSessions.operations();
  const members = input.deps.projectMembers.operations();
  const scheduler = input.deps.workerScheduler.forExperience(input.atomPackId, input.experienceId);
  const namespaceIdempotencyKey = (key: string): string => `${input.atomPackId}:${key}`;
  const authorized = <T>(permission: WorkplaceExperiencePermission, operation: () => Promise<T>): Promise<T> => {
    try {
      requirePermission(permission);
      return operation();
    } catch (error) {
      return Promise.reject(error);
    }
  };

  return {
    atomPackId: input.atomPackId,
    experienceId: input.experienceId,
    experienceState: {
      get: (projectId, key) => authorized('experience.state', () => state.get(projectId, key)),
      list: (projectId, prefix) => authorized('experience.state', () => state.list(projectId, prefix)),
      compareAndSwap: (request) => authorized('experience.state', () => state.compareAndSwap(request)),
      compareAndDelete: (request) => authorized('experience.state', () => state.compareAndDelete(request))
    },
    projectSessions: {
      list: (projectId) => authorized('project.sessions.read', () => sessions.list(projectId)),
      create: (projectId, request) =>
        authorized('project.sessions.create', () =>
          sessions.create(projectId, { ...request, idempotencyKey: namespaceIdempotencyKey(request.idempotencyKey) })
        ),
      sendMessage: (sessionId, request) =>
        authorized('project.sessions.send', () =>
          sessions.sendMessage(sessionId, {
            ...request,
            idempotencyKey: namespaceIdempotencyKey(request.idempotencyKey)
          })
        ),
      listMessages: (sessionId, cursor) =>
        authorized('project.sessions.read', () => sessions.listMessages(sessionId, cursor)),
      ...(sessions.listArtifacts
        ? {
            listArtifacts: (sessionId: string) =>
              authorized('project.sessions.read', () => sessions.listArtifacts?.(sessionId) ?? Promise.resolve([]))
          }
        : {}),
      listObservations: (sessionId, cursor) =>
        authorized('project.observations.read', () => sessions.listObservations(sessionId, cursor)),
      runTurn: (sessionId, request) =>
        authorized('project.sessions.send', () =>
          sessions.runTurn(sessionId, { ...request, idempotencyKey: namespaceIdempotencyKey(request.idempotencyKey) })
        ),
      getRun: (sessionId, runId) => authorized('project.sessions.read', () => sessions.getRun(sessionId, runId)),
      pause: (sessionId) => authorized('project.sessions.send', () => sessions.pause(sessionId)),
      cancel: (sessionId) => authorized('project.sessions.send', () => sessions.cancel(sessionId)),
      listPendingApprovals: (projectId, sessionId) =>
        authorized('project.approvals.read', () => sessions.listPendingApprovals(projectId, sessionId)),
      resolveApproval: (approvalId, decision) =>
        authorized('project.approvals.resolve', () => sessions.resolveApproval(approvalId, decision))
    },
    projectMembers: {
      listTemplates: (projectId) => authorized('project.members.read', () => members.listTemplates(projectId)),
      listSessionMembers: (sessionId) =>
        authorized('project.members.read', () => members.listSessionMembers(sessionId)),
      inviteSessionMember: (sessionId, templateId) =>
        authorized('project.members.invite', () => members.inviteSessionMember(sessionId, templateId)),
      removeSessionMember: (sessionId, memberId) =>
        authorized('project.members.remove', () => members.removeSessionMember(sessionId, memberId))
    },
    requestInteraction: (request) =>
      input.deps.interactions.request(
        { kind: 'atom-pack', packId: input.atomPackId, atomId: input.experienceId },
        request,
        { mode: 'foreground' }
      ),
    workerScheduler: {
      schedule: (projectId, request) => authorized('experience.worker', () => scheduler.schedule(projectId, request)),
      cancel: (projectId, key) => authorized('experience.worker', () => scheduler.cancel(projectId, key))
    }
  };
}
