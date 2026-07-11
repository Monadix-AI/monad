import type { AgentConfig } from '@monad/home';
import type { Agent, AgentId, CreateAgentRequest, PrincipalId, UpdateAgentRequest } from '@monad/protocol';
import type { AgentContext } from './context.ts';

import { newId } from '@monad/protocol';

import { disposeSandboxAgent } from '#/capabilities/tools';
import { HandlerError } from '#/handlers/handler-error.ts';
import { deleteAgentDir, loadAgentBody, toAgentDir, writeAgentBody } from '#/store/home/agent-def.ts';

function toWireAgent(a: AgentConfig, principalId: PrincipalId, hasPrompt: boolean): Agent {
  return {
    id: a.id as AgentId,
    principalId,
    name: a.name,
    description: a.description,
    modelAlias: a.modelAlias,
    roles: a.roles,
    model: a.model,
    framework: a.framework,
    capabilities: a.capabilities,
    declaredScopes: a.declaredScopes,
    atoms: a.atoms,
    sandboxMode: a.sandbox?.mode,
    maxTurns: a.maxTurns,
    maxThinkingTokens: a.maxThinkingTokens,
    maxBudgetUsd: a.maxBudgetUsd,
    visibility: a.visibility,
    a2a: a.a2a,
    hasPrompt
  };
}

/** The on-disk dir holding this agent's AGENT.md. Legacy rows without `dir` fall back to a name slug. */
function agentDirOf(a: AgentConfig): string {
  return a.dir ?? toAgentDir(a.name);
}

/** Pick a `dir` slug not already used by another agent (collision → `-2`, `-3`, …). */
function uniqueDir(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

export function createAgentHandlers(ctx: AgentContext, ownerPrincipalId: PrincipalId) {
  const hasPromptFor = async (a: AgentConfig): Promise<boolean> =>
    (await loadAgentBody(ctx.paths.agents, agentDirOf(a))) !== undefined;

  const wire = async (a: AgentConfig): Promise<Agent> => toWireAgent(a, ownerPrincipalId, await hasPromptFor(a));

  return {
    async listAgents() {
      const cfg = await ctx.read();
      return { agents: await Promise.all(cfg.agent.agents.map(wire)) };
    },

    async getAgent({ agentId }: { agentId: AgentId }) {
      const cfg = await ctx.read();
      const found = cfg.agent.agents.find((a) => a.id === agentId);
      if (!found) throw new HandlerError('not_found', `agent not found: ${agentId}`);
      return { agent: await wire(found) };
    },

    async createAgent(req: CreateAgentRequest) {
      const cfg = await ctx.read();
      const id = newId('agt') as AgentId;
      const taken = new Set(cfg.agent.agents.map(agentDirOf));
      const dir = uniqueDir(toAgentDir(req.name), taken);
      const newAgent: AgentConfig = {
        id,
        name: req.name,
        dir,
        description: req.description,
        modelAlias: req.modelAlias,
        roles: req.roles,
        model: req.model,
        framework: req.framework,
        capabilities: req.capabilities ?? [],
        declaredScopes: [],
        atoms: req.atoms ?? { mode: 'inherit', allow: [], deny: [] },
        sandbox: req.sandboxMode ? { mode: req.sandboxMode } : undefined,
        maxTurns: req.maxTurns,
        maxThinkingTokens: req.maxThinkingTokens,
        maxBudgetUsd: req.maxBudgetUsd,
        visibility: req.visibility ?? { subagentCallable: false, public: false },
        a2a: req.a2a ?? { enabled: false }
      };
      let hasPrompt = false;
      if (req.prompt?.trim()) {
        await writeAgentBody(ctx.paths.agents, dir, { name: req.name, description: req.description }, req.prompt);
        hasPrompt = true;
      }
      cfg.agent.agents.push(newAgent);
      await ctx.commit(cfg);
      return { agent: toWireAgent(newAgent, ownerPrincipalId, hasPrompt) };
    },

    async updateAgent({ agentId, ...patch }: UpdateAgentRequest & { agentId: AgentId }) {
      const cfg = await ctx.read();
      const a = cfg.agent.agents.find((x) => x.id === agentId);
      if (!a) throw new HandlerError('not_found', `agent not found: ${agentId}`);
      if (patch.name !== undefined) a.name = patch.name;
      if (patch.description !== undefined) a.description = patch.description;
      if (patch.modelAlias !== undefined) a.modelAlias = patch.modelAlias;
      if (patch.roles !== undefined) a.roles = patch.roles;
      if (patch.model !== undefined) a.model = patch.model;
      if (patch.framework !== undefined) a.framework = patch.framework;
      if (patch.capabilities !== undefined) a.capabilities = patch.capabilities;
      if (patch.atoms !== undefined) a.atoms = patch.atoms;
      let sandboxChanged = false;
      if (patch.sandboxMode !== undefined && a.sandbox?.mode !== patch.sandboxMode) {
        a.sandbox = { mode: patch.sandboxMode };
        sandboxChanged = true;
      }
      if (patch.maxTurns !== undefined) a.maxTurns = patch.maxTurns;
      if (patch.maxThinkingTokens !== undefined) a.maxThinkingTokens = patch.maxThinkingTokens;
      if (patch.maxBudgetUsd !== undefined) a.maxBudgetUsd = patch.maxBudgetUsd;
      if (patch.visibility !== undefined) a.visibility = patch.visibility;
      if (patch.a2a !== undefined) a.a2a = patch.a2a;
      await ctx.commit(cfg);
      // A per-agent sandbox-mode change alters the policy a running VM was built for; destroy the old
      // VM so it never outlives its policy (same security constraint as deleteAgent).
      if (sandboxChanged) disposeSandboxAgent(agentId);
      return { agent: await wire(a) };
    },

    async getAgentPrompt({ agentId }: { agentId: AgentId }) {
      const cfg = await ctx.read();
      const a = cfg.agent.agents.find((x) => x.id === agentId);
      if (!a) throw new HandlerError('not_found', `agent not found: ${agentId}`);
      return { prompt: (await loadAgentBody(ctx.paths.agents, agentDirOf(a))) ?? '' };
    },

    async setAgentPrompt({ agentId, prompt }: { agentId: AgentId; prompt: string }) {
      const cfg = await ctx.read();
      const a = cfg.agent.agents.find((x) => x.id === agentId);
      if (!a) throw new HandlerError('not_found', `agent not found: ${agentId}`);
      // Pin a stable dir for legacy rows before the file lands at its location.
      if (!a.dir) {
        a.dir = uniqueDir(toAgentDir(a.name), new Set(cfg.agent.agents.filter((x) => x !== a).map(agentDirOf)));
        await ctx.commit(cfg);
      }
      await writeAgentBody(ctx.paths.agents, a.dir, { name: a.name, description: a.description }, prompt);
      return { prompt };
    },

    async deleteAgent({ agentId }: { agentId: AgentId }) {
      const cfg = await ctx.read();
      const found = cfg.agent.agents.find((a) => a.id === agentId);
      if (!found) throw new HandlerError('not_found', `agent not found: ${agentId}`);
      cfg.agent.agents = cfg.agent.agents.filter((a) => a.id !== agentId);
      if (cfg.agent.defaultAgentId === agentId) cfg.agent.defaultAgentId = undefined;
      await ctx.commit(cfg);
      await deleteAgentDir(ctx.paths.agents, agentDirOf(found));
      // A heavy launcher (the VM backend) may hold a per-agent instance built for this agent's
      // now-deleted sandbox policy; destroy it so a stale VM never outlives the agent. Security
      // constraint, not cleanup — see disposeSandboxAgent.
      disposeSandboxAgent(agentId);
      return { ok: true as const };
    },

    async getDefaultAgent() {
      const cfg = await ctx.read();
      return { agentId: (cfg.agent.defaultAgentId ?? null) as AgentId | null };
    },

    async setDefaultAgent({ agentId }: { agentId: AgentId }) {
      const cfg = await ctx.read();
      if (!cfg.agent.agents.some((a) => a.id === agentId)) {
        throw new HandlerError('not_found', `agent not found: ${agentId}`);
      }
      cfg.agent.defaultAgentId = agentId;
      await ctx.commit(cfg);
      return { ok: true as const };
    }
  };
}
