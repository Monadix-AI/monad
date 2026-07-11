import type { ConfigSource } from './service.ts';

import {
  loadAll,
  loadAuth as loadHomeAuth,
  type MonadAuth,
  type MonadConfig,
  type MonadPaths,
  saveAuth as saveHomeAuth,
  saveProfile
} from '@monad/home';

export interface HomeConfigIo {
  loadConfig(configPath: string, profilePath: string): Promise<MonadConfig | null>;
  loadAuth(authPath: string): Promise<MonadAuth | null>;
  saveConfig(profilePath: string, config: MonadConfig): Promise<void>;
  saveAuth(authPath: string, auth: MonadAuth): Promise<void>;
}

export interface HomeConfigSourceOptions {
  io?: HomeConfigIo;
  watch?: (onChange: () => void) => () => void;
}

const defaultIo: HomeConfigIo = {
  loadConfig: loadAll,
  loadAuth: loadHomeAuth,
  saveConfig: saveProfile,
  saveAuth: saveHomeAuth
};

export function createHomeConfigSource(
  paths: Pick<MonadPaths, 'auth' | 'config' | 'profile'>,
  options: HomeConfigSourceOptions = {}
): ConfigSource {
  const io = options.io ?? defaultIo;

  return {
    async load() {
      const [cfg, auth] = await Promise.all([io.loadConfig(paths.config, paths.profile), io.loadAuth(paths.auth)]);
      return cfg === null ? null : { cfg, auth };
    },
    saveConfig: (config) => io.saveConfig(paths.profile, config),
    saveAuth: (auth) => io.saveAuth(paths.auth, auth),
    ...(options.watch === undefined ? {} : { watch: options.watch })
  };
}
