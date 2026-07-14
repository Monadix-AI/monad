import type {
  ExperienceStateStore,
  ExperienceWorkerScheduler,
  ProjectSessionOperations,
  WorkspaceExperienceApiContext,
  WorkspaceExperiencePermission
} from '@monad/sdk-atom';

export interface ExperienceCapabilityDeps {
  state: {
    forPack(atomPackId: string, principalId: string): ExperienceStateStore;
  };
  projectSessions: {
    forPrincipal(principalId: string): ProjectSessionOperations;
  };
  workerScheduler: {
    forExperience(atomPackId: string, principalId: string, experienceId: string): ExperienceWorkerScheduler;
  };
}

function permissionGuard(permissions: readonly WorkspaceExperiencePermission[]) {
  const granted = new Set(permissions);
  return (permission: WorkspaceExperiencePermission): void => {
    if (!granted.has(permission)) throw new Error(`workspace Experience permission required: ${permission}`);
  };
}

export function createWorkspaceExperienceApiContext(input: {
  atomPackId: string;
  principalId: string;
  experienceId: string;
  permissions: readonly WorkspaceExperiencePermission[];
  deps: ExperienceCapabilityDeps;
}): WorkspaceExperienceApiContext {
  const requirePermission = permissionGuard(input.permissions);
  const state = input.deps.state.forPack(input.atomPackId, input.principalId);
  const sessions = input.deps.projectSessions.forPrincipal(input.principalId);
  const scheduler = input.deps.workerScheduler.forExperience(input.atomPackId, input.principalId, input.experienceId);
  const namespaceIdempotencyKey = (key: string): string => `${input.atomPackId}:${key}`;
  const authorized = <T>(permission: WorkspaceExperiencePermission, operation: () => Promise<T>): Promise<T> => {
    try {
      requirePermission(permission);
      return operation();
    } catch (error) {
      return Promise.reject(error);
    }
  };

  return {
    atomPackId: input.atomPackId,
    principalId: input.principalId,
    experienceId: input.experienceId,
    experienceState: {
      get: (projectId, key) => authorized('experience.state', () => state.get(projectId, key)),
      list: (projectId, prefix) => authorized('experience.state', () => state.list(projectId, prefix)),
      compareAndSwap: (request) => authorized('experience.state', () => state.compareAndSwap(request))
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
      listObservations: (sessionId, cursor) =>
        authorized('project.observations.read', () => sessions.listObservations(sessionId, cursor)),
      runTurn: (sessionId, request) =>
        authorized('project.sessions.send', () =>
          sessions.runTurn(sessionId, { ...request, idempotencyKey: namespaceIdempotencyKey(request.idempotencyKey) })
        ),
      pause: (sessionId) => authorized('project.sessions.send', () => sessions.pause(sessionId)),
      cancel: (sessionId) => authorized('project.sessions.send', () => sessions.cancel(sessionId)),
      listPendingApprovals: (projectId, sessionId) =>
        authorized('project.approvals.read', () => sessions.listPendingApprovals(projectId, sessionId)),
      resolveApproval: (approvalId, decision) =>
        authorized('project.approvals.resolve', () => sessions.resolveApproval(approvalId, decision))
    },
    workerScheduler: {
      schedule: (projectId, request) => authorized('experience.worker', () => scheduler.schedule(projectId, request)),
      cancel: (projectId, key) => authorized('experience.worker', () => scheduler.cancel(projectId, key))
    }
  };
}
