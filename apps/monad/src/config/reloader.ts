import type { ConfigSnapshot } from './service.ts';

export interface ConfigReloader {
  publish(snapshot: ConfigSnapshot): Promise<void>;
}

export function createConfigReloader(requestReload: (snapshot: ConfigSnapshot) => Promise<void>): ConfigReloader {
  return { publish: requestReload };
}
