import { expect, test } from 'bun:test';

import { ReloadCoordinator } from '#/config/reload.ts';
import { manualScheduler } from './helpers.ts';

test('collapses an event burst into one trailing apply', async () => {
  const clock = manualScheduler();
  let applies = 0;
  const coordinator = new ReloadCoordinator({ apply: async () => void applies++, scheduler: clock.scheduler });

  coordinator.request();
  coordinator.request();
  coordinator.request();

  expect(clock.pendingCount()).toBe(1);
  clock.runNext();
  await coordinator.whenIdle();
  expect(applies).toBe(1);
});

test('runs one trailing follow-up when invalidated during apply', async () => {
  const clock = manualScheduler();
  const releases: Array<() => void> = [];
  let active = 0;
  let maxActive = 0;
  let applies = 0;
  const coordinator = new ReloadCoordinator({
    scheduler: clock.scheduler,
    apply: async () => {
      applies++;
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
    }
  });

  coordinator.request();
  clock.runNext();
  await Bun.sleep(0);
  coordinator.request();
  coordinator.request();
  expect(clock.pendingCount()).toBe(0);
  releases.shift()?.();
  await Bun.sleep(0);
  expect(clock.pendingCount()).toBe(1);
  clock.runNext();
  await Bun.sleep(0);
  releases.shift()?.();
  await coordinator.whenIdle();

  expect({ applies, maxActive }).toEqual({ applies: 2, maxActive: 1 });
});

test('stop cancels a trailing timer and waits for an active apply', async () => {
  const clock = manualScheduler();
  let applies = 0;
  const coordinator = new ReloadCoordinator({ apply: async () => void applies++, scheduler: clock.scheduler });

  coordinator.request();
  await coordinator.stop();

  expect({ applies, pending: clock.pendingCount() }).toEqual({ applies: 0, pending: 0 });
});

test('routes background apply errors and remains reusable', async () => {
  const clock = manualScheduler();
  const errors: string[] = [];
  let applies = 0;
  const coordinator = new ReloadCoordinator({
    scheduler: clock.scheduler,
    onError: (error) => errors.push((error as Error).message),
    apply: async () => {
      applies++;
      if (applies === 1) throw new Error('invalid config');
    }
  });

  coordinator.request();
  clock.runNext();
  await coordinator.whenIdle();
  coordinator.request();
  clock.runNext();
  await coordinator.whenIdle();

  expect({ applies, errors }).toEqual({ applies: 2, errors: ['invalid config'] });
});
