import { expect, test } from 'bun:test';

import { installPreloadErrorRecovery } from '#/lib/preload-error-recovery';

function recoveryHarness(lastReloadAt?: string) {
  let listener: ((event: Event) => void) | undefined;
  let reloads = 0;
  const storage = new Map<string, string>();
  if (lastReloadAt !== undefined) storage.set('monad:preload-reload-at', lastReloadAt);

  installPreloadErrorRecovery(
    {
      addEventListener(_type, next) {
        listener = next;
      },
      location: { reload: () => reloads++ },
      sessionStorage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value)
      }
    },
    () => 20_000
  );

  return {
    dispatch() {
      let prevented = false;
      listener?.({ preventDefault: () => (prevented = true) } as unknown as Event);
      return { prevented, reloads };
    },
    storage
  };
}

test('reloads once when a release preload fails', () => {
  const harness = recoveryHarness();

  expect(harness.dispatch()).toEqual({ prevented: true, reloads: 1 });
  expect(harness.storage.get('monad:preload-reload-at')).toBe('20000');
});

test('suppresses a reload loop when the recovered page still cannot preload', () => {
  const harness = recoveryHarness('15001');

  expect(harness.dispatch()).toEqual({ prevented: true, reloads: 0 });
});
