import type { ExperienceStateStore, ExperienceWorkerScheduler } from '@monad/sdk-atom';
import type { Store } from '#/store/db/index.ts';

function assertProject(store: Store, projectId: string): void {
  const project = store.getWorkplaceProject(projectId);
  if (!project) throw new Error(`project not found: ${projectId}`);
}

export function createExperienceStateStore(store: Store, atomPackId: string): ExperienceStateStore {
  return {
    get: async <T>(projectId: string, key: string) => {
      assertProject(store, projectId);
      const record = store.getExperienceState(atomPackId, projectId, key);
      return record ? { value: record.value as T, version: record.version } : null;
    },
    list: async <T>(projectId: string, prefix: string) => {
      assertProject(store, projectId);
      return store
        .listExperienceState(atomPackId, projectId, prefix)
        .map((record) => ({ key: record.key, value: record.value as T, version: record.version }));
    },
    compareAndSwap: async (input) => {
      assertProject(store, input.projectId);
      return store.compareAndSwapExperienceState({ atomPackId, ...input });
    }
  };
}

export function createExperienceWorkerScheduler(
  store: Store,
  atomPackId: string,
  experienceId: string
): ExperienceWorkerScheduler {
  return {
    schedule: async (projectId, input) => {
      assertProject(store, projectId);
      store.scheduleExperienceWorkerWakeup({
        atomPackId,
        experienceId,
        projectId,
        key: input.key,
        runAt: input.runAt
      });
    },
    cancel: async (projectId, key) => {
      assertProject(store, projectId);
      store.cancelExperienceWorkerWakeup(atomPackId, experienceId, projectId, key);
    }
  };
}
