import type { ReloadScheduler } from '#/config/reload.ts';

export function manualScheduler() {
  let nextId = 0;
  const pending = new Map<number, () => void>();
  return {
    scheduler: {
      set: (callback: () => void) => {
        const id = ++nextId;
        pending.set(id, callback);
        return id;
      },
      clear: (id: unknown) => pending.delete(id as number)
    } satisfies ReloadScheduler,
    runNext: () => {
      const entry = pending.entries().next().value as [number, () => void] | undefined;
      if (!entry) throw new Error('no scheduled reload');
      pending.delete(entry[0]);
      entry[1]();
    },
    pendingCount: () => pending.size
  };
}
