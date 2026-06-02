import type { MonadConfig } from '@monad/environment';
import type { AtomRegistriesView } from '@monad/protocol';

export function atomRegistryCredentials(cfg: MonadConfig): {
  githubToken?: string;
  npmToken?: string;
  npmRegistry?: string;
} {
  return {
    githubToken: cfg.atomRegistries.github?.token,
    npmToken: cfg.atomRegistries.npm?.token,
    npmRegistry: cfg.atomRegistries.npm?.registry
  };
}

export function atomRegistriesToView(cfg: MonadConfig): AtomRegistriesView {
  return {
    github: cfg.atomRegistries.github
      ? { token: { configured: cfg.atomRegistries.github.token !== undefined } }
      : undefined,
    npm: cfg.atomRegistries.npm
      ? {
          token: { configured: cfg.atomRegistries.npm.token !== undefined },
          registry: cfg.atomRegistries.npm.registry
        }
      : undefined
  };
}
