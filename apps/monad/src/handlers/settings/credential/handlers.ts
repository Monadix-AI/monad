import type { AgentCredential } from '@monad/environment';
import type {
  AgentCredentialCapability,
  AgentCredentialView,
  CreateAgentCredentialRequest,
  DeleteAgentCredentialResponse,
  ListAgentCredentialsResponse,
  UpdateAgentCredentialRequest
} from '@monad/protocol';
import type { CredentialContext } from './context.ts';

import { emptyAuth } from '@monad/environment';
import { createAgentCredentialRequestSchema, newId, updateAgentCredentialRequestSchema } from '@monad/protocol';
import { protectedExecutionAvailable } from '@monad/sandbox';

import { HandlerError } from '#/handlers/handler-error.ts';

function toView(
  id: string,
  credential: AgentCredential,
  authorizedAgentIds: AgentCredentialView['authorizedAgentIds']
): AgentCredentialView {
  return {
    id,
    label: credential.label,
    description: credential.description,
    environmentVariable: credential.environmentVariable,
    allowedHosts: credential.allowedHosts,
    configured: credential.secret !== undefined,
    authorizedAgentIds
  };
}

function authorizedAgents(ctx: CredentialContext, credentialId: string): AgentCredentialView['authorizedAgentIds'] {
  return ctx
    .read()
    .cfg.agent.agents.filter((agent) => agent.credentialIds.includes(credentialId))
    .map((agent) => agent.id);
}

export function createCredentialHandlers(ctx: CredentialContext) {
  return {
    async listCredentials(): Promise<ListAgentCredentialsResponse> {
      const snapshot = ctx.read();
      return {
        credentials: Object.entries(snapshot.auth?.credentials ?? {}).map(([id, credential]) =>
          toView(
            id,
            credential,
            snapshot.cfg.agent.agents.filter((agent) => agent.credentialIds.includes(id)).map((agent) => agent.id)
          )
        )
      };
    },

    async createCredential(request: CreateAgentCredentialRequest): Promise<AgentCredentialView> {
      const req = createAgentCredentialRequestSchema.parse(request);
      const id = newId('cred');
      const now = new Date().toISOString();
      let created: AgentCredential | undefined;
      await ctx.update((snapshot) => {
        const auth = snapshot.auth ?? emptyAuth();
        created = {
          label: req.label,
          description: req.description,
          environmentVariable: req.environmentVariable,
          secret: req.secret,
          allowedHosts: req.allowedHosts,
          createdAt: now,
          updatedAt: now
        };
        auth.credentials[id] = created;
        auth.updatedAt = now;
        snapshot.auth = auth;
      });
      if (!created) throw new HandlerError('internal', 'agent_credential_create_failed');
      return toView(id, created, []);
    },

    async updateCredential(id: string, request: UpdateAgentCredentialRequest): Promise<AgentCredentialView> {
      const req = updateAgentCredentialRequestSchema.parse(request);
      const now = new Date().toISOString();
      let updated: AgentCredential | undefined;
      await ctx.update((snapshot) => {
        const auth = snapshot.auth;
        const existing = auth?.credentials[id];
        if (!auth || !existing) {
          throw new HandlerError('not_found', 'agent_credential_not_found', 'agent_credential_not_found', {
            credentialId: id
          });
        }
        updated = {
          ...existing,
          ...(req.label === undefined ? {} : { label: req.label }),
          ...(req.description === undefined ? {} : { description: req.description }),
          ...(req.environmentVariable === undefined ? {} : { environmentVariable: req.environmentVariable }),
          ...(req.allowedHosts === undefined ? {} : { allowedHosts: req.allowedHosts }),
          ...(req.secret?.action === 'replace' ? { secret: req.secret.value } : {}),
          updatedAt: now
        };
        if (req.secret?.action === 'remove') delete updated.secret;
        auth.credentials[id] = updated;
        auth.updatedAt = now;
      });
      if (!updated) throw new HandlerError('internal', 'agent_credential_update_failed');
      return toView(id, updated, authorizedAgents(ctx, id));
    },

    async deleteCredential(id: string): Promise<DeleteAgentCredentialResponse> {
      let affectedAgentIds: DeleteAgentCredentialResponse['affectedAgentIds'] = [];
      await ctx.update((snapshot) => {
        const auth = snapshot.auth;
        if (!auth?.credentials[id]) {
          throw new HandlerError('not_found', 'agent_credential_not_found', 'agent_credential_not_found', {
            credentialId: id
          });
        }
        affectedAgentIds = snapshot.cfg.agent.agents
          .filter((agent) => agent.credentialIds.includes(id))
          .map((agent) => agent.id);
        delete auth.credentials[id];
        auth.updatedAt = new Date().toISOString();
        for (const agent of snapshot.cfg.agent.agents) {
          if (agent.credentialIds.includes(id)) {
            agent.credentialIds = agent.credentialIds.filter((credentialId) => credentialId !== id);
          }
        }
      });
      return { ok: true, affectedAgentIds };
    },

    async getCapability(): Promise<AgentCredentialCapability> {
      return protectedExecutionAvailable()
        ? { available: true }
        : { available: false, code: 'protected_execution_unavailable' };
    }
  };
}
