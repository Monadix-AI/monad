import type { Stats } from 'node:fs';
import type { LogAutoCleanup, MonadConfig } from '@monad/environment';
import type { ConfigSnapshot, ConfigSource } from '#/config/manager.ts';
import type { RuntimeModule } from '#/runtime/types.ts';
import type {
  LogMaintenanceLifecycleScheduler,
  LogMaintenanceLifecycleTimer
} from '#/services/log-maintenance/lifecycle.ts';

import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { createDefaultConfig } from '@monad/environment';

import { createDaemonRuntime } from '#/runtime/create.ts';
import { RuntimeKernel } from '#/runtime/kernel.ts';
import { createLogMaintenanceLifecycleModule } from '#/services/log-maintenance/lifecycle.ts';
import { LogMaintenanceService } from '#/services/log-maintenance.ts';

const DAY_MS = 24 * 60 * 60 * 1_000;

function snapshot(enabled: boolean, retentionDays = 14): ConfigSnapshot {
  const cfg = createDefaultConfig('Test');
  return { auth: null, cfg: { ...cfg, logs: { autoCleanup: { enabled, retentionDays } } } };
}

function source(initial: ConfigSnapshot): ConfigSource {
  return {
    load: async () => initial,
    saveConfig: async (_cfg: MonadConfig) => {},
    saveAuth: async () => {}
  };
}

function storeModule(): RuntimeModule<ConfigSnapshot> {
  return { id: 'store', criticality: 'required', start: async () => ({}) };
}

function directoryStats(id: number): Stats {
  return {
    dev: 1,
    ino: id,
    isDirectory: () => true,
    isFile: () => false,
    isSymbolicLink: () => false
  } as Stats;
}

function manualLifecycleScheduler() {
  let nextId = 0;
  const microtasks: Array<() => void> = [];
  const timeouts = new Map<number, { callback: () => void; delayMs: number }>();
  const intervals = new Map<number, { callback: () => void; delayMs: number; timer: LogMaintenanceLifecycleTimer }>();
  const cleared: Array<'interval' | 'timeout'> = [];
  const scheduler: LogMaintenanceLifecycleScheduler = {
    queueMicrotask: (callback) => microtasks.push(callback),
    setTimeout: (callback, delayMs) => {
      const id = ++nextId;
      timeouts.set(id, { callback, delayMs });
      return id;
    },
    clearTimeout: (handle) => {
      if (timeouts.delete(handle as number)) cleared.push('timeout');
    },
    setInterval: (callback, delayMs) => {
      const id = ++nextId;
      const timer = {
        id,
        unrefCalls: 0,
        unref() {
          this.unrefCalls += 1;
        }
      };
      intervals.set(id, { callback, delayMs, timer });
      return timer;
    },
    clearInterval: (handle) => {
      const id = (handle as { id: number }).id;
      if (intervals.delete(id)) cleared.push('interval');
    }
  };
  return {
    scheduler,
    cleared,
    intervals,
    timeouts,
    runMicrotasks() {
      for (const callback of microtasks.splice(0)) callback();
    },
    runTimeout() {
      const entry = timeouts.entries().next().value as [number, { callback: () => void; delayMs: number }] | undefined;
      if (!entry) throw new Error('no scheduled lifecycle timeout');
      timeouts.delete(entry[0]);
      entry[1].callback();
    }
  };
}

function recordingService(sweeps: Array<{ enabled: boolean; retentionDays: number }>): LogMaintenanceService {
  return {
    clearAll: async () => ({ filesCleared: 0, filesFailed: 0, bytesFreed: 0 }),
    preview: async () => ({ files: 0, bytes: 0 }),
    stop: () => {},
    sweep: async (policy: LogAutoCleanup) => {
      sweeps.push(policy);
      return { filesCleared: 0, filesFailed: 0, bytesFreed: 0 };
    }
  } as unknown as LogMaintenanceService;
}

test('queues the startup sweep only after the runtime reaches ready', async () => {
  const clock = manualLifecycleScheduler();
  const events: string[] = [];
  let inventoryCompleted!: () => void;
  const inventory = new Promise<void>((resolveInventory) => {
    inventoryCompleted = resolveInventory;
  });
  const initial = snapshot(true);
  const lifecycle = createLogMaintenanceLifecycleModule({
    initial,
    paths: { logs: '/logs' },
    scheduler: clock.scheduler,
    serviceOptions: {
      debugDir: '/debug',
      debugPath: '/debug/current.log',
      fileSystem: {
        lstat: async (path) => {
          events.push(`lstat:${path}`);
          return directoryStats(path.length);
        },
        readdir: async (path) => {
          events.push(`readdir:${path}`);
          if (path === resolve('/logs', 'live-events')) inventoryCompleted();
          return [];
        }
      }
    }
  });
  const kernel = new RuntimeKernel([storeModule(), lifecycle]);

  await kernel.start();

  expect({ events, phase: kernel.state.getState().phase }).toEqual({ events: [], phase: 'ready' });
  clock.runMicrotasks();
  await inventory;
  expect(events).toEqual([
    `lstat:${resolve('/logs')}`,
    `lstat:${resolve('/debug')}`,
    `lstat:${resolve('/logs', 'mesh-agent-fixture-capture')}`,
    `lstat:${resolve('/logs', 'live-events')}`,
    `readdir:${resolve('/logs')}`,
    `readdir:${resolve('/debug')}`,
    `readdir:${resolve('/logs', 'mesh-agent-fixture-capture')}`,
    `lstat:${resolve('/logs', 'live-events')}`,
    `readdir:${resolve('/logs', 'live-events')}`
  ]);
  await kernel.stop();
});

test('coalesces a policy burst into one sweep using only the last value after 500 ms', async () => {
  const clock = manualLifecycleScheduler();
  const sweeps: Array<{ enabled: boolean; retentionDays: number }> = [];
  const initial = snapshot(false);
  let runtime!: ReturnType<typeof createDaemonRuntime>;
  const lifecycle = createLogMaintenanceLifecycleModule({
    initial,
    paths: { logs: '/logs' },
    scheduler: clock.scheduler,
    config: () => runtime.config,
    createService: () => recordingService(sweeps)
  });
  runtime = createDaemonRuntime({
    initial,
    modules: [storeModule(), lifecycle],
    source: source(initial),
    watchOnStart: false
  });
  await runtime.start();
  clock.runMicrotasks();

  for (const retentionDays of [14, 7, 3]) {
    await runtime.config.updateConfig((cfg) => ({
      ...cfg,
      logs: { autoCleanup: { enabled: true, retentionDays } }
    }));
  }

  expect({
    intervals: clock.intervals.size,
    sweeps,
    timeouts: [...clock.timeouts.values()].map((x) => x.delayMs)
  }).toEqual({
    intervals: 0,
    sweeps: [],
    timeouts: [500]
  });
  clock.runTimeout();
  await Promise.resolve();
  await Promise.resolve();
  expect({ intervals: [...clock.intervals.values()].map((x) => x.delayMs), sweeps }).toEqual({
    intervals: [DAY_MS],
    sweeps: [{ enabled: true, retentionDays: 3 }]
  });
  await runtime.stop();
});

test('keeps accepted policy scheduling unchanged while a disabling snapshot is pending or rejected', async () => {
  const clock = manualLifecycleScheduler();
  const sweeps: Array<{ enabled: boolean; retentionDays: number }> = [];
  const initial = snapshot(true);
  let runtime!: ReturnType<typeof createDaemonRuntime>;
  let reloadStarted!: () => void;
  let rejectReload!: (error: Error) => void;
  const reloadPending = new Promise<void>((resolve) => {
    reloadStarted = resolve;
  });
  const rejection = new Promise<never>((_resolve, reject) => {
    rejectReload = reject;
  });
  let blockReload = true;
  const lifecycle = createLogMaintenanceLifecycleModule({
    initial,
    paths: { logs: '/logs' },
    scheduler: clock.scheduler,
    config: () => runtime.config,
    createService: () => recordingService(sweeps)
  });
  const downstream: RuntimeModule<ConfigSnapshot> = {
    id: 'downstream',
    criticality: 'required',
    requires: ['services.log-maintenance'],
    start: async () => 'ready',
    reload: async (current) => {
      if (!blockReload) return current;
      reloadStarted();
      return rejection;
    }
  };
  runtime = createDaemonRuntime({
    initial,
    modules: [storeModule(), lifecycle, downstream],
    source: source(initial),
    watchOnStart: false
  });
  await runtime.start();
  clock.runMicrotasks();
  await Promise.resolve();
  await Promise.resolve();

  const disabling = runtime.config.updateConfig((cfg) => ({
    ...cfg,
    logs: { autoCleanup: { enabled: false, retentionDays: 14 } }
  }));
  await reloadPending;

  expect({
    accepted: runtime.config.get().cfg.logs.autoCleanup,
    cleared: clock.cleared,
    intervals: clock.intervals.size,
    sweeps,
    timeouts: clock.timeouts.size
  }).toEqual({
    accepted: { enabled: true, retentionDays: 14 },
    cleared: [],
    intervals: 1,
    sweeps: [{ enabled: true, retentionDays: 14 }],
    timeouts: 0
  });

  rejectReload(new Error('downstream rejected snapshot'));
  await expect(disabling).rejects.toThrow('downstream rejected snapshot');
  expect({
    accepted: runtime.config.get().cfg.logs.autoCleanup,
    cleared: clock.cleared,
    intervals: clock.intervals.size,
    sweeps,
    timeouts: clock.timeouts.size
  }).toEqual({
    accepted: { enabled: true, retentionDays: 14 },
    cleared: [],
    intervals: 1,
    sweeps: [{ enabled: true, retentionDays: 14 }],
    timeouts: 0
  });

  blockReload = false;
  await runtime.config.updateConfig((cfg) => ({
    ...cfg,
    logs: { autoCleanup: { enabled: true, retentionDays: 7 } }
  }));
  expect({
    accepted: runtime.config.get().cfg.logs.autoCleanup,
    cleared: clock.cleared,
    intervals: clock.intervals.size,
    timeouts: [...clock.timeouts.values()].map((entry) => entry.delayMs)
  }).toEqual({
    accepted: { enabled: true, retentionDays: 7 },
    cleared: ['interval'],
    intervals: 0,
    timeouts: [500]
  });
  await runtime.stop();
});

test('unreferences the 24-hour maintenance timer', async () => {
  const clock = manualLifecycleScheduler();
  const initial = snapshot(true);
  const lifecycle = createLogMaintenanceLifecycleModule({
    initial,
    paths: { logs: '/logs' },
    scheduler: clock.scheduler,
    createService: () => recordingService([])
  });
  const runtime = createDaemonRuntime({
    initial,
    modules: [storeModule(), lifecycle],
    source: source(initial),
    watchOnStart: false
  });

  await runtime.start();

  expect(
    [...clock.intervals.values()].map(({ delayMs, timer }) => ({
      delayMs,
      unrefCalls: (timer as { unrefCalls: number }).unrefCalls
    }))
  ).toEqual([{ delayMs: DAY_MS, unrefCalls: 1 }]);
  await runtime.stop();
});

test('stop cancels scheduling, rejects new work, and abandons an active filesystem continuation', async () => {
  const clock = manualLifecycleScheduler();
  let inventoryStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    inventoryStarted = resolve;
  });
  const never = new Promise<Stats>(() => {});
  const initial = snapshot(true);
  let runtime!: ReturnType<typeof createDaemonRuntime>;
  const lifecycle = createLogMaintenanceLifecycleModule({
    initial,
    paths: { logs: '/logs' },
    scheduler: clock.scheduler,
    config: () => runtime.config,
    serviceOptions: {
      fileSystem: {
        lstat: async () => {
          inventoryStarted();
          return never;
        }
      }
    }
  });
  runtime = createDaemonRuntime({
    initial,
    modules: [storeModule(), lifecycle],
    source: source(initial),
    watchOnStart: false
  });
  await runtime.start();
  const service = runtime.kernel.context.get<LogMaintenanceService>('services.log-maintenance');
  clock.runMicrotasks();
  await started;
  await runtime.config.updateConfig((cfg) => ({
    ...cfg,
    logs: { autoCleanup: { enabled: true, retentionDays: 7 } }
  }));

  await runtime.stop();

  expect({ cleared: clock.cleared.sort(), intervals: clock.intervals.size, timeouts: clock.timeouts.size }).toEqual({
    cleared: ['interval', 'timeout'],
    intervals: 0,
    timeouts: 0
  });
  await expect(service.clearAll()).rejects.toThrow('Log maintenance service has stopped');
  await expect(service.sweep({ enabled: true, retentionDays: 7 })).rejects.toThrow(
    'Log maintenance service has stopped'
  );
});
