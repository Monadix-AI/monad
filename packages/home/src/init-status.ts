import type { InitMissingItem, MissingProviderCredential } from '@monad/protocol';
import type { MonadPaths } from './paths.ts';

import { existsSync } from 'node:fs';

import { DEFAULT_SAMPLE_PROVIDER_ID, loadAll, loadAuth, type MonadAuth, type MonadConfig } from './config/index.ts';

export interface InitStatus {
  initialized: boolean;
  missing: InitMissingItem[];
  missingProviderCredentials?: MissingProviderCredential[];
}

/**
 * Derive initialization status from config + auth state.
 *
 * "Initialized" means a real (non-sample) provider has been configured with
 * at least one credential, and a default profile pointing to it exists.
 * The seeded sample provider (no credentials) does not count.
 */
export function computeInitStatus(cfg: MonadConfig, auth: MonadAuth | null): InitStatus {
  const missing: InitMissingItem[] = [];
  const missingProviderCredentials: MissingProviderCredential[] = [];

  const defaultAlias = cfg.model.default || 'default';
  const profile = cfg.model.profiles.find((p) => p.alias === defaultAlias);
  if (!profile) {
    missing.push('provider', 'credential', 'default');
    return { initialized: false, missing };
  }

  const provider = cfg.model.providers.find((p) => p.id === profile.routes.chat.provider);
  if (!provider || provider.id === DEFAULT_SAMPLE_PROVIDER_ID) {
    missing.push('provider', 'credential');
    const replacementProfile =
      profile.alias === 'default' ? undefined : cfg.model.profiles.find((candidate) => candidate.alias === 'default');
    const replacementProvider = replacementProfile
      ? cfg.model.providers.find((p) => p.id === replacementProfile.routes.chat.provider)
      : undefined;
    const targetProfile = replacementProvider ? replacementProfile : profile;
    const targetProvider = replacementProvider ?? provider;
    if (targetProvider && targetProvider.id !== DEFAULT_SAMPLE_PROVIDER_ID && targetProfile) {
      missingProviderCredentials.push({
        providerId: targetProvider.id,
        providerLabel: targetProvider.label,
        profileAlias: targetProfile.alias,
        route: 'chat'
      });
    }
    return missingProviderCredentials.length
      ? { initialized: false, missing, missingProviderCredentials }
      : { initialized: false, missing };
  }

  const creds = auth?.credentialPool[provider.id] ?? [];
  if (creds.length === 0) {
    missing.push('credential');
    missingProviderCredentials.push({
      providerId: provider.id,
      providerLabel: provider.label,
      profileAlias: profile.alias,
      route: 'chat'
    });
    return { initialized: false, missing, missingProviderCredentials };
  }

  if (!cfg.agent.agents.length || !cfg.agent.defaultAgentId) {
    missing.push('agent');
    return { initialized: false, missing };
  }

  return { initialized: true, missing: [] };
}

/**
 * Check initialization status from disk (config.json must exist and parse).
 * Returns uninitialized if config.json is absent or unparseable.
 */
export async function isHomeInitialized(paths: MonadPaths): Promise<InitStatus> {
  if (!existsSync(paths.config)) {
    return { initialized: false, missing: ['provider', 'credential', 'default'] };
  }
  const cfg = await loadAll(paths.config, paths.profile);
  if (!cfg) {
    return { initialized: false, missing: ['provider', 'credential', 'default'] };
  }
  const auth = await loadAuth(paths.auth);
  return computeInitStatus(cfg, auth);
}
