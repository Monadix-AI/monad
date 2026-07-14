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

export class BaselineCoordinator {
  constructor(private readonly cache: BaselineCache) {}

  async acquire(options: BaselineAcquireOptions): Promise<BaselineAcquireResult> {
    if (!options.enabled || !isBaselineDriver(options.driver)) {
      return { handle: await options.coldBoot(), source: 'cold' };
    }
    const driver: VmBaselineDriver = options.driver;
    const restoreLease = await this.cache.acquireRestoreLease(options.identity);
    if (restoreLease) {
      try {
        const handle = await driver.restoreBaseline(options.spec, restoreLease.artifact);
        try {
          await options.confirm(handle, {
            bootEpoch: restoreLease.artifact.manifest.bootEpoch,
            agentDigest: restoreLease.artifact.manifest.guest.agent
          });
          return { handle, source: 'restored' };
        } catch (error) {
          await handle.stop().catch(() => {});
          throw error;
        }
      } catch {
        await restoreLease.release();
        await this.cache.invalidate(options.identity);
      } finally {
        await restoreLease.release();
      }
    }

    const handle = await options.coldBoot();
    const captureLease = await this.cache.acquireCaptureLease(options.identity).catch(() => undefined);
    if (!captureLease) return { handle, source: 'cold' };
    let handshake: BaselineHandshake | undefined;
    try {
      handshake = await options.prepare(handle);
      await this.cache.publish({ ...options.manifest, bootEpoch: handshake.bootEpoch }, async (dir) =>
        driver.captureBaseline(options.spec, handle, dir)
      );
    } catch {
      await this.cache.invalidate(options.identity);
    } finally {
      if (handshake) await options.confirm(handle, handshake);
      await captureLease.release();
    }
    return { handle, source: 'cold' };
  }
}
