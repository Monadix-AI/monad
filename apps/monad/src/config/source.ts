import type { ConfigSource } from './manager.ts';

import {
  loadAll,
  loadAuth as loadHomeAuth,
  type MonadAuth,
  type MonadConfig,
  type MonadPaths,
  saveAll,
  saveAuth as saveHomeAuth
} from '@monad/environment';

export interface HomeConfigIo {
  loadConfig(paths: Pick<MonadPaths, 'config' | 'agentsConfig' | 'mesh'>): Promise<MonadConfig | null>;
  loadAuth(authPath: string): Promise<MonadAuth | null>;
  saveConfig(paths: Pick<MonadPaths, 'config' | 'agentsConfig' | 'mesh'>, config: MonadConfig): Promise<void>;
  saveAuth(authPath: string, auth: MonadAuth): Promise<void>;
}

export interface HomeConfigSourceOptions {
  io?: HomeConfigIo;
  watch?: (onChange: () => void) => () => void;
}

const defaultIo: HomeConfigIo = {
  loadConfig: loadAll,
  loadAuth: loadHomeAuth,
  saveConfig: saveAll,
  saveAuth: saveHomeAuth
};

export function createHomeConfigSource(
  paths: Pick<MonadPaths, 'auth' | 'config' | 'agentsConfig' | 'mesh'>,
  options: HomeConfigSourceOptions = {}
): ConfigSource {
  const io = options.io ?? defaultIo;

  return {
    async load() {
      const [cfg, auth] = await Promise.all([io.loadConfig(paths), io.loadAuth(paths.auth)]);
      return cfg === null ? null : { cfg, auth };
    },
    saveConfig: (config) => io.saveConfig(paths, config),
    saveAuth: (auth) => io.saveAuth(paths.auth, auth),
    ...(options.watch === undefined ? {} : { watch: options.watch })
  };
}
