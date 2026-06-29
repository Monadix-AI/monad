import type { InitMissingItem } from '@monad/protocol';
import type { MonadPaths } from './paths.ts';

import { existsSync } from 'node:fs';

import { DEFAULT_SAMPLE_PROVIDER_ID, loadAll, loadAuth, type MonadAuth, type MonadConfig } from './config.ts';

export interface InitStatus {
  initialized: boolean;
  missing: InitMissingItem[];
}

/**
 * Derive initialization status from config + auth state.
 *
 * "Initialized" means a real (non-sample) provider has been configured with
 * at least one credential, and a default profile pointing to it exists.
 * The seeded sample provider (no credentials) does not count.
 */
export function computeInitStatus(cfg: MonadConfig, auth: MonadAuth | null): InitStatus {
  if (!auth) return { initialized: false, missing: ['provider', 'credential', 'default'] };
  const missing: InitMissingItem[] = [];

  const defaultAlias = cfg.model.default || 'default';
  const profile = cfg.model.profiles.find((p) => p.alias === defaultAlias);
  if (!profile) {
    missing.push('provider', 'credential', 'default');
    return { initialized: false, missing };
  }

  const provider = cfg.model.providers.find((p) => p.id === profile.routes.chat.provider);
  if (!provider || provider.id === DEFAULT_SAMPLE_PROVIDER_ID) {
    missing.push('provider', 'credential');
    return { initialized: false, missing };
  }

  const creds = auth.credentialPool[provider.id] ?? [];
  if (creds.length === 0) {
    missing.push('credential');
    return { initialized: false, missing };
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
