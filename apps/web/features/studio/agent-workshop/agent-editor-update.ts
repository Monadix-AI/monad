import type { Agent, AgentId, SandboxMode, UpdateAgentRequest } from '@monad/protocol';

export interface AgentEditorUpdateInput {
  agent: Agent;
  agentId: AgentId;
  atomsAllow: string[];
  atomsMode: 'inherit' | 'allowlist';
  description: string;
  isPublic: boolean;
  maxBudgetUsd: string;
  maxThinkingTokens: string;
  maxTurns: string;
  model: string;
  name: string;
  roles: Record<string, string>;
  sandboxMode: SandboxMode | '';
  subagentCallable: boolean;
  a2aEnabled: boolean;
}

export function buildAgentEditorUpdate({
  agent,
  agentId,
  atomsAllow,
  atomsMode,
  description,
  isPublic,
  maxBudgetUsd,
  maxThinkingTokens,
  maxTurns,
  model,
  name,
  roles,
  sandboxMode,
  subagentCallable,
  a2aEnabled
}: AgentEditorUpdateInput): { agentId: AgentId } & UpdateAgentRequest {
  return {
    agentId,
    name: name.trim() || undefined,
    description: description.trim() || undefined,
    model: model.trim() || undefined,
    sandboxMode: sandboxMode || undefined,
    maxTurns: maxTurns.trim() ? parseInt(maxTurns, 10) : undefined,
    maxThinkingTokens: maxThinkingTokens.trim() ? parseInt(maxThinkingTokens, 10) : undefined,
    maxBudgetUsd: maxBudgetUsd.trim() ? parseFloat(maxBudgetUsd) : undefined,
    roles,
    atoms: { mode: atomsMode, allow: atomsAllow, deny: agent.atoms?.deny ?? [] },
    visibility: { subagentCallable, public: isPublic },
    a2a: { enabled: a2aEnabled }
  };
}
