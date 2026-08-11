import type { MonadPaths } from '@monad/environment';
import type { ConfigAccess, ConfigSnapshot } from '#/config/manager.ts';
import type { RuntimeModule } from '#/runtime/types.ts';
import type { LogMaintenanceServiceOptions } from '../log-maintenance.ts';

import { LogMaintenanceService } from '../log-maintenance.ts';
import { meshFixtureCaptureDirectory, meshLiveEventLogsDirectory } from '../mesh-agent/fixture-paths.ts';

export const LOG_MAINTENANCE_MODULE_ID = 'services.log-maintenance';

const DAY_MS = 24 * 60 * 60 * 1_000;
const POLICY_DEBOUNCE_MS = 500;

export interface LogMaintenanceLifecycleTimer {
  unref?(): void;
}

export interface LogMaintenanceLifecycleScheduler {
  queueMicrotask(callback: () => void): void;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, delayMs: number): LogMaintenanceLifecycleTimer;
  clearInterval(handle: LogMaintenanceLifecycleTimer): void;
}

export interface LogMaintenanceLifecycleOptions {
  initial: ConfigSnapshot;
  paths: Pick<MonadPaths, 'logs'>;
  config?: () => Pick<ConfigAccess, 'subscribe'>;
  logger?: { warn(message: string): void };
  scheduler?: LogMaintenanceLifecycleScheduler;
  serviceOptions?: Omit<LogMaintenanceServiceOptions, 'captureDir' | 'logsDir'>;
  createService?: (options: LogMaintenanceServiceOptions) => LogMaintenanceService;
}

interface LifecycleState {
  service: LogMaintenanceService;
  policy: ConfigSnapshot['cfg']['logs']['autoCleanup'];
  signal: AbortSignal;
  activated: boolean;
  stopped: boolean;
  debounceTimer?: unknown;
  periodicTimer?: LogMaintenanceLifecycleTimer;
  unsubscribe?: () => void;
}

const defaultScheduler: LogMaintenanceLifecycleScheduler = {
  queueMicrotask: (callback) => queueMicrotask(callback),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
};

export function createLogMaintenanceLifecycleModule(
  options: LogMaintenanceLifecycleOptions
): RuntimeModule<ConfigSnapshot> {
  const scheduler = options.scheduler ?? defaultScheduler;
  const createService = options.createService ?? ((serviceOptions) => new LogMaintenanceService(serviceOptions));
  let state: LifecycleState | undefined;

  const cancelDebounce = (current: LifecycleState) => {
    if (current.debounceTimer === undefined) return;
    scheduler.clearTimeout(current.debounceTimer);
    current.debounceTimer = undefined;
  };
  const cancelPeriodic = (current: LifecycleState) => {
    if (current.periodicTimer === undefined) return;
    scheduler.clearInterval(current.periodicTimer);
    current.periodicTimer = undefined;
  };
  const queueSweep = (current: LifecycleState, policy: LifecycleState['policy']) => {
    if (current.stopped || current.signal.aborted || !policy.enabled) return;
    void current.service.sweep(policy).catch(() => {
      options.logger?.warn('monad: scheduled log maintenance failed');
    });
  };
  const armPeriodic = (current: LifecycleState) => {
    cancelPeriodic(current);
    if (current.stopped || !current.policy.enabled) return;
    current.periodicTimer = scheduler.setInterval(() => queueSweep(current, current.policy), DAY_MS);
    current.periodicTimer.unref?.();
  };
  const stop = (current: LifecycleState) => {
    if (current.stopped) return;
    current.stopped = true;
    cancelDebounce(current);
    cancelPeriodic(current);
    current.unsubscribe?.();
    current.unsubscribe = undefined;
    current.service.stop();
  };
  const applyAcceptedPolicy = (current: LifecycleState, nextPolicy: LifecycleState['policy']) => {
    if (current.stopped) return;
    if (current.policy.enabled === nextPolicy.enabled && current.policy.retentionDays === nextPolicy.retentionDays) {
      return;
    }
    current.policy = nextPolicy;
    cancelDebounce(current);
    cancelPeriodic(current);
    if (!nextPolicy.enabled) return;
    current.debounceTimer = scheduler.setTimeout(() => {
      current.debounceTimer = undefined;
      queueSweep(current, current.policy);
      armPeriodic(current);
    }, POLICY_DEBOUNCE_MS);
  };

  return {
    id: LOG_MAINTENANCE_MODULE_ID,
    criticality: 'required',
    after: ['store'],
    start: async (_context, signal) => {
      const service = createService({
        logsDir: options.paths.logs,
        captureDir: meshFixtureCaptureDirectory(options.paths),
        liveEventDir: meshLiveEventLogsDirectory(options.paths),
        ...options.serviceOptions
      });
      const current: LifecycleState = {
        service,
        policy: options.initial.cfg.logs.autoCleanup,
        signal,
        activated: false,
        stopped: false
      };
      state = current;
      current.unsubscribe = options.config?.().subscribe(
        (snapshot) => snapshot.cfg.logs.autoCleanup,
        (nextPolicy) => applyAcceptedPolicy(current, nextPolicy)
      );
      signal.addEventListener('abort', () => stop(current), { once: true });
      return service;
    },
    afterReady: () => {
      const current = state;
      if (!current || current.activated || current.stopped || current.signal.aborted) return;
      current.activated = true;
      if (!current.policy.enabled) return;
      armPeriodic(current);
      scheduler.queueMicrotask(() => queueSweep(current, current.policy));
    },
    stop: () => {
      if (state) stop(state);
    }
  };
}
