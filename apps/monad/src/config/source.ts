import type { ConfigSource } from './manager.ts';

import {
  loadAll,
  loadAuth as loadHomeAuth,
  loadSnapshot as loadHomeSnapshot,
  type MonadAuth,
  type MonadConfig,
  type MonadPaths,
  saveAll,
  saveAuth as saveHomeAuth,
  saveSnapshot as saveHomeSnapshot
} from '@monad/environment';

export interface HomeConfigIo {
  loadConfig(paths: Pick<MonadPaths, 'config' | 'agentsConfig' | 'mesh'>): Promise<MonadConfig | null>;
  loadAuth(authPath: string): Promise<MonadAuth | null>;
  saveConfig(paths: Pick<MonadPaths, 'config' | 'agentsConfig' | 'mesh'>, config: MonadConfig): Promise<void>;
  saveAuth(authPath: string, auth: MonadAuth): Promise<void>;
  loadSnapshot?(
    paths: Pick<MonadPaths, 'auth' | 'config' | 'agentsConfig' | 'mesh'>
  ): Promise<{ cfg: MonadConfig; auth: MonadAuth | null } | null>;
  saveSnapshot?(
    paths: Pick<MonadPaths, 'auth' | 'config' | 'agentsConfig' | 'mesh'>,
    previous: { cfg: MonadConfig; auth: MonadAuth | null },
    next: { cfg: MonadConfig; auth: MonadAuth | null }
  ): Promise<void>;
}

export interface HomeConfigSourceOptions {
  io?: HomeConfigIo;
  watch?: (onChange: () => void) => () => void;
}

const defaultIo: HomeConfigIo = {
  loadConfig: loadAll,
  loadAuth: loadHomeAuth,
  saveConfig: saveAll,
  saveAuth: saveHomeAuth,
  loadSnapshot: loadHomeSnapshot,
  saveSnapshot: saveHomeSnapshot
};

export function createHomeConfigSource(
  paths: Pick<MonadPaths, 'auth' | 'config' | 'agentsConfig' | 'mesh'>,
  options: HomeConfigSourceOptions = {}
): ConfigSource {
  const io = options.io ?? defaultIo;

  return {
    async load() {
      if (io.loadSnapshot) return io.loadSnapshot(paths);
      const [cfg, auth] = await Promise.all([io.loadConfig(paths), io.loadAuth(paths.auth)]);
      return cfg === null ? null : { cfg, auth };
    },
    saveConfig: (config) => io.saveConfig(paths, config),
    saveAuth: (auth) => io.saveAuth(paths.auth, auth),
    ...(io.saveSnapshot === undefined
      ? {}
      : { saveSnapshot: (previous, next) => io.saveSnapshot?.(paths, previous, next) ?? Promise.resolve() }),
    ...(options.watch === undefined ? {} : { watch: options.watch })
  };
}
