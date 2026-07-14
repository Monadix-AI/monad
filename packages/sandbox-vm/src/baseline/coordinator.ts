import type { VmBaselineDriver, VmDriver, VmHandle, VmSpec } from '../driver/vfkit.ts';
import type { BaselineManifestInput } from './cache.ts';

import { isBaselineDriver } from '../driver/vfkit.ts';
import { BaselineCache } from './cache.ts';

export interface BaselineHandshake {
  bootEpoch: string;
  agentDigest: string;
}

export interface BaselineAcquireOptions {
  enabled: boolean;
  identity: string;
  manifest: Omit<BaselineManifestInput, 'bootEpoch'>;
  spec: VmSpec;
  driver: VmDriver;
  coldBoot(): Promise<VmHandle>;
  prepare(handle: VmHandle): Promise<BaselineHandshake>;
  confirm(handle: VmHandle, handshake: BaselineHandshake): Promise<void>;
}

export interface BaselineAcquireResult {
  handle: VmHandle;
  source: 'cold' | 'restored';
}

export interface BaselineMetrics {
  cold: number;
  restored: number;
  captureFailures: number;
  restoreFailures: number;
  coldMs: number[];
  restoreMs: number[];
}

export class BaselineCoordinator {
  private readonly values: BaselineMetrics = {
    cold: 0,
    restored: 0,
    captureFailures: 0,
    restoreFailures: 0,
    coldMs: [],
    restoreMs: []
  };

  constructor(private readonly cache: BaselineCache) {}

  metrics(): BaselineMetrics {
    return { ...this.values, coldMs: [...this.values.coldMs], restoreMs: [...this.values.restoreMs] };
  }

  async acquire(options: BaselineAcquireOptions): Promise<BaselineAcquireResult> {
    if (!options.enabled || !isBaselineDriver(options.driver)) {
      const started = performance.now();
      const handle = await options.coldBoot();
      this.recordCold(started);
      return { handle, source: 'cold' };
    }
    const driver: VmBaselineDriver = options.driver;
    const restoreLease = await this.cache.acquireRestoreLease(options.identity);
    if (restoreLease) {
      if (!sameManifestIdentity(restoreLease.artifact.manifest, options.manifest)) {
        await restoreLease.release();
        await this.cache.invalidate(options.identity);
        return this.acquireCold(options, driver);
      }
      try {
        const started = performance.now();
        const handle = await driver.restoreBaseline(options.spec, restoreLease.artifact);
        try {
          await options.confirm(handle, {
            bootEpoch: restoreLease.artifact.manifest.bootEpoch,
            agentDigest: restoreLease.artifact.manifest.guest.agent
          });
          this.values.restored++;
          pushSample(this.values.restoreMs, performance.now() - started);
          return { handle, source: 'restored' };
        } catch (error) {
          await handle.stop().catch(() => {});
          throw error;
        }
      } catch {
        this.values.restoreFailures++;
        await restoreLease.release();
        await driver.invalidateBaseline(restoreLease.artifact).catch(() => {});
        await this.cache.invalidate(options.identity);
      } finally {
        await restoreLease.release();
      }
    }

    return this.acquireCold(options, driver);
  }

  private async acquireCold(options: BaselineAcquireOptions, driver: VmBaselineDriver): Promise<BaselineAcquireResult> {
    const started = performance.now();
    const handle = await options.coldBoot();
    this.values.cold++;
    const captureLease = await this.cache.acquireCaptureLease(options.identity).catch(() => undefined);
    if (!captureLease) {
      pushSample(this.values.coldMs, performance.now() - started);
      return { handle, source: 'cold' };
    }
    let handshake: BaselineHandshake | undefined;
    try {
      handshake = await options.prepare(handle);
      await this.cache.publish({ ...options.manifest, bootEpoch: handshake.bootEpoch }, async (dir) =>
        driver.captureBaseline(options.spec, handle, dir)
      );
    } catch {
      this.values.captureFailures++;
      await this.cache.invalidate(options.identity);
    }
    if (handshake) {
      try {
        await options.confirm(handle, handshake);
      } catch {
        await handle.stop().catch(() => {});
        await this.cache.invalidate(options.identity);
        await captureLease.release();
        const retryStarted = performance.now();
        const retry = await options.coldBoot();
        this.recordCold(retryStarted);
        return { handle: retry, source: 'cold' };
      }
    }
    try {
      pushSample(this.values.coldMs, performance.now() - started);
      return { handle, source: 'cold' };
    } finally {
      await captureLease.release();
    }
  }

  private recordCold(started: number): void {
    this.values.cold++;
    pushSample(this.values.coldMs, performance.now() - started);
  }
}

function pushSample(samples: number[], value: number): void {
  samples.push(value);
  if (samples.length > 256) samples.shift();
}

function sameManifestIdentity(
  cached: BaselineManifestInput,
  expected: Omit<BaselineManifestInput, 'bootEpoch'>
): boolean {
  return (
    cached.identity === expected.identity &&
    cached.reuseDigest === expected.reuseDigest &&
    JSON.stringify(cached.driver) === JSON.stringify(expected.driver) &&
    JSON.stringify(cached.guest) === JSON.stringify(expected.guest) &&
    JSON.stringify(cached.topology) === JSON.stringify(expected.topology)
  );
}
