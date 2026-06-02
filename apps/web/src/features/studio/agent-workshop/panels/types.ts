import type {
  A2aAgentStatus,
  AgentCredentialCapability,
  AgentCredentialView,
  AgentId,
  SandboxMode
} from '@monad/protocol';
import type { AgentFlowValidation, AgentInstructionDraft } from '../agent-flow-model';

export interface AgentFlowCapability {
  available: boolean;
  detail: string;
  id: string;
  name: string;
  sourceKind: 'tool' | 'atom' | 'mcp' | 'agent-mcp';
}

export interface AgentFlowSkill {
  available: boolean;
  detail: string;
  id: string;
  name: string;
  sourceKind: 'global' | 'atom-pack' | 'agent';
}

export interface IdentityPanelProps {
  errors: Pick<AgentFlowValidation['errors'], 'name'>;
  instructions: AgentInstructionDraft;
  name: string;
  setInstructions: (value: AgentInstructionDraft) => void;
  setName: (value: string) => void;
}

export interface ModelsPanelProps {
  errors: Pick<AgentFlowValidation['errors'], 'maxBudgetUsd' | 'maxThinkingTokens' | 'maxTurns'>;
  maxBudgetUsd: string;
  maxThinkingTokens: string;
  maxTurns: string;
  model: string;
  profiles: { alias: string }[];
  roles: Record<string, string>;
  setMaxBudgetUsd: (value: string) => void;
  setMaxThinkingTokens: (value: string) => void;
  setMaxTurns: (value: string) => void;
  setModel: (value: string) => void;
  setRoles: (value: Record<string, string> | ((current: Record<string, string>) => Record<string, string>)) => void;
}

export interface ToolsPanelProps {
  agentDir: string;
  agentId: AgentId;
  atomsAllow: string[];
  atomsMode: 'inherit' | 'allowlist';
  capabilityCatalog: AgentFlowCapability[];
  capabilityCatalogLoading: boolean;
  onRefresh: () => void;
  setAtomsAllow: (value: string[] | ((current: string[]) => string[])) => void;
  setAtomsMode: (value: 'inherit' | 'allowlist') => void;
}

export interface SkillsPanelProps {
  agentDir: string;
  agentId: AgentId;
  onRefresh: () => void;
  setSkillsAllow: (value: string[] | ((current: string[]) => string[])) => void;
  setSkillsMode: (value: 'inherit' | 'allowlist') => void;
  skills: AgentFlowSkill[];
  skillsAllow: string[];
  skillsLoading: boolean;
  skillsMode: 'inherit' | 'allowlist';
}

export interface MemoryPanelProps {
  agentId: AgentId;
  advancedMemoryEnabled: boolean;
  memoryAutoConsolidate: boolean;
  memoryEnabled: boolean;
  memoryIntervalMinutes: string;
  setAdvancedMemoryEnabled: (value: boolean) => void;
  setMemoryAutoConsolidate: (value: boolean) => void;
  setMemoryEnabled: (value: boolean) => void;
  setMemoryIntervalMinutes: (value: string) => void;
}

export interface SandboxPanelProps {
  credentialCapability?: AgentCredentialCapability;
  credentialCapabilityLoading: boolean;
  credentialError?: string;
  credentialIds: string[];
  credentials: AgentCredentialView[];
  credentialsError: boolean;
  credentialsLoading: boolean;
  sandboxMode: SandboxMode | '';
  setCredentialIds: (value: string[] | ((current: string[]) => string[])) => void;
  setSandboxMode: (value: SandboxMode | '') => void;
}

export interface ChannelsPanelProps {
  a2aEnabled: boolean;
  a2aStatus?: A2aAgentStatus;
  isPublic: boolean;
  monadixConsume: boolean;
  setA2aEnabled: (value: boolean) => void;
  setIsPublic: (value: boolean) => void;
  setMonadixConsume: (value: boolean) => void;
  setSubagentCallable: (value: boolean) => void;
  subagentCallable: boolean;
}
