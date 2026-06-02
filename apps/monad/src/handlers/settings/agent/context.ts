import type { MonadConfig, MonadPaths } from '@monad/environment';
import type { ConfigAccess } from '#/config/manager.ts';

import { HandlerError } from '#/handlers/handler-error.ts';

export interface AgentDeps {
  paths: MonadPaths;
  config: ConfigAccess;
}

export interface AgentContext {
  /** Daemon paths — handlers need `paths.agents` to read/write each agent's AGENT.md. */
  paths: MonadPaths;
  read(): Promise<MonadConfig>;
  configuredAgents(): MonadConfig['agent']['agents'];
  validateCredentialIds(credentialIds: string[]): void;
  commit(cfg: MonadConfig, credentialIds?: string[]): Promise<void>;
  commitCreatedAgent(cfg: MonadConfig, credentialIds: string[], installPrompt?: () => Promise<void>): Promise<void>;
}

export function createAgentContext({ paths, config }: AgentDeps): AgentContext {
  async function read(): Promise<MonadConfig> {
    return structuredClone(config.get().cfg);
  }

  function configuredAgents(): MonadConfig['agent']['agents'] {
    return config.get().cfg.agent.agents;
  }

  function validateCredentialIds(credentialIds: string[]): void {
    validateCredentialGrants(config.get().auth, credentialIds);
  }

  async function commit(cfg: MonadConfig, credentialIds?: string[]): Promise<void> {
    await config.update((snapshot) => {
      if (credentialIds) validateCredentialGrants(snapshot.auth, credentialIds);
      snapshot.cfg = cfg;
    });
  }

  async function commitCreatedAgent(
    cfg: MonadConfig,
    credentialIds: string[],
    installPrompt?: () => Promise<void>
  ): Promise<void> {
    await config.update(async (snapshot) => {
      validateCredentialGrants(snapshot.auth, credentialIds);
      await installPrompt?.();
      snapshot.cfg = cfg;
    });
  }

  return { paths, read, configuredAgents, validateCredentialIds, commit, commitCreatedAgent };
}

function validateCredentialGrants(auth: ReturnType<ConfigAccess['get']>['auth'], credentialIds: string[]): void {
  const environmentVariables = new Set<string>();
  for (const credentialId of credentialIds) {
    const credential = auth?.credentials[credentialId];
    if (!credential) {
      throw new HandlerError('invalid', 'agent_credential_not_found', 'agent_credential_not_found', { credentialId });
    }
    if (environmentVariables.has(credential.environmentVariable)) {
      throw new HandlerError(
        'invalid',
        'agent_credential_environment_variable_conflict',
        'agent_credential_environment_variable_conflict',
        { environmentVariable: credential.environmentVariable }
      );
    }
    environmentVariables.add(credential.environmentVariable);
  }
}
