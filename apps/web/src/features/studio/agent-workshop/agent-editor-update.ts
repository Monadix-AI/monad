import type { Agent, AgentId, SandboxMode, UpdateAgentRequest } from '@monad/protocol';

export interface AgentEditorUpdateInput {
  agent: Agent;
  agentId: AgentId;
  atomsAllow: string[];
  atomsMode: 'inherit' | 'allowlist';
  credentialIds: string[];
  isPublic: boolean;
  memoryEnabled: boolean;
  advancedMemoryEnabled: boolean;
  memoryAutoConsolidate: boolean;
  memoryIntervalMinutes: string;
  maxBudgetUsd: string;
  maxThinkingTokens: string;
  maxTurns: string;
  model: string;
  name: string;
  roles: Record<string, string>;
  sandboxMode: SandboxMode | '';
  skillsAllow: string[];
  skillsAutoload: boolean;
  skillsDisabled: string[];
  skillsMode: 'inherit' | 'allowlist';
  subagentCallable: boolean;
  a2aEnabled: boolean;
  monadixConsume: boolean;
}

export function buildAgentEditorUpdate({
  agent,
  agentId,
  atomsAllow,
  atomsMode,
  credentialIds,
  isPublic,
  memoryEnabled,
  advancedMemoryEnabled,
  memoryAutoConsolidate,
  memoryIntervalMinutes,
  maxBudgetUsd,
  maxThinkingTokens,
  maxTurns,
  model,
  name,
  roles,
  sandboxMode,
  skillsAllow,
  skillsAutoload,
  skillsDisabled,
  skillsMode,
  subagentCallable,
  a2aEnabled,
  monadixConsume
}: AgentEditorUpdateInput): { agentId: AgentId } & UpdateAgentRequest {
  const parsedMemoryInterval = Number.parseInt(memoryIntervalMinutes, 10);
  const intervalMinutes =
    Number.isInteger(parsedMemoryInterval) && parsedMemoryInterval > 0
      ? parsedMemoryInterval
      : agent.memory.intervalMinutes;
  return {
    agentId,
    name: name.trim() || undefined,
    model: model.trim() || undefined,
    sandboxMode: sandboxMode || undefined,
    maxTurns: maxTurns.trim() ? parseInt(maxTurns, 10) : undefined,
    maxThinkingTokens: maxThinkingTokens.trim() ? parseInt(maxThinkingTokens, 10) : undefined,
    maxBudgetUsd: maxBudgetUsd.trim() ? parseFloat(maxBudgetUsd) : undefined,
    credentialIds,
    roles,
    memory: {
      enabled: memoryEnabled,
      advanced: advancedMemoryEnabled,
      autoConsolidate: memoryAutoConsolidate,
      intervalMinutes
    },
    atoms: { mode: atomsMode, allow: atomsAllow, deny: agent.atoms?.deny ?? [] },
    skills: { mode: skillsMode, allow: skillsAllow, autoload: skillsAutoload, disabled: skillsDisabled },
    visibility: { subagentCallable, public: isPublic },
    a2a: { enabled: a2aEnabled },
    monadix: { consume: monadixConsume }
  };
}
