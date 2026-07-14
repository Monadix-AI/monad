import type { ExperienceStateStore, ExperienceWorkerScheduler } from '@monad/sdk-atom';
import type { Store } from '#/store/db/index.ts';

export function createExperienceStateStore(
  store: Store,
  atomPackId: string,
  principalId: string
): ExperienceStateStore {
  return {
    get: async <T>(projectId: string, key: string) => {
      const record = store.getExperienceState(atomPackId, principalId, projectId, key);
      return record ? { value: record.value as T, version: record.version } : null;
    },
    list: async <T>(projectId: string, prefix: string) =>
      store
        .listExperienceState(atomPackId, principalId, projectId, prefix)
        .map((record) => ({ key: record.key, value: record.value as T, version: record.version })),
    compareAndSwap: async (input) =>
      store.compareAndSwapExperienceState({ atomPackId, principalId, ...input })
  };
}

export function createExperienceWorkerScheduler(
  store: Store,
  atomPackId: string,
  principalId: string
): ExperienceWorkerScheduler {
  return {
    schedule: async (projectId, input) => {
      store.scheduleExperienceWorkerWakeup({ atomPackId, principalId, projectId, key: input.key, runAt: input.runAt });
    },
    cancel: async (projectId, key) => {
      store.cancelExperienceWorkerWakeup(atomPackId, principalId, projectId, key);
    }
  };
}
