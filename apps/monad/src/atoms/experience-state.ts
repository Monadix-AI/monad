import type { ExperienceStateStore, ExperienceWorkerScheduler } from '@monad/sdk-atom';
import type { Store } from '#/store/db/index.ts';

function assertProjectOwner(store: Store, principalId: string, projectId: string): void {
  const project = store.getWorkplaceProject(projectId);
  if (!project || project.ownerPrincipalId !== principalId) throw new Error(`project not found: ${projectId}`);
}

export function createExperienceStateStore(
  store: Store,
  atomPackId: string,
  principalId: string
): ExperienceStateStore {
  return {
    get: async <T>(projectId: string, key: string) => {
      assertProjectOwner(store, principalId, projectId);
      const record = store.getExperienceState(atomPackId, principalId, projectId, key);
      return record ? { value: record.value as T, version: record.version } : null;
    },
    list: async <T>(projectId: string, prefix: string) => {
      assertProjectOwner(store, principalId, projectId);
      return store
        .listExperienceState(atomPackId, principalId, projectId, prefix)
        .map((record) => ({ key: record.key, value: record.value as T, version: record.version }));
    },
    compareAndSwap: async (input) => {
      assertProjectOwner(store, principalId, input.projectId);
      return store.compareAndSwapExperienceState({ atomPackId, principalId, ...input });
    }
  };
}

export function createExperienceWorkerScheduler(
  store: Store,
  atomPackId: string,
  principalId: string,
  experienceId: string
): ExperienceWorkerScheduler {
  return {
    schedule: async (projectId, input) => {
      assertProjectOwner(store, principalId, projectId);
      store.scheduleExperienceWorkerWakeup({
        atomPackId,
        principalId,
        experienceId,
        projectId,
        key: input.key,
        runAt: input.runAt
      });
    },
    cancel: async (projectId, key) => {
      assertProjectOwner(store, principalId, projectId);
      store.cancelExperienceWorkerWakeup(atomPackId, principalId, experienceId, projectId, key);
    }
  };
}
