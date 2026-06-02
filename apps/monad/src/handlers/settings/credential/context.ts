import type { ConfigAccess, ConfigSnapshot } from '#/config/manager.ts';

export interface CredentialContext {
  read(): ConfigSnapshot;
  update(mutate: (snapshot: ConfigSnapshot) => void): Promise<ConfigSnapshot>;
}

export function createCredentialContext(config: ConfigAccess): CredentialContext {
  return {
    read: () => structuredClone(config.get()),
    update: (mutate) =>
      config.update((snapshot) => {
        mutate(snapshot);
        return undefined;
      })
  };
}
