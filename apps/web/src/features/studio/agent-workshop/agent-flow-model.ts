import type { SandboxMode } from '@monad/protocol';

export type AgentFlowNodeId = 'request' | 'identity' | 'model' | 'tools' | 'safety' | 'response';

export interface AgentFlowInput {
  a2aEnabled: boolean;
  atomsAllow: string[];
  atomsMode: 'inherit' | 'allowlist';
  isPublic: boolean;
  maxBudgetUsd: string;
  maxThinkingTokens: string;
  maxTurns: string;
  model: string;
  name: string;
  prompt: string;
  sandboxMode: SandboxMode | '';
  subagentCallable: boolean;
}

export interface AgentFlowValidation {
  errors: Partial<Record<'name' | 'maxTurns' | 'maxThinkingTokens' | 'maxBudgetUsd', string>>;
  saveBlocked: boolean;
}

export interface AgentFlowReadiness {
  label: 'Needs attention' | 'Ready to use';
  optionalImprovements: number;
  saveBlocked: boolean;
}

const POSITIVE_NUMBER_ERROR = 'Enter a number greater than 0.';
const POSITIVE_INTEGER_ERROR = 'Enter a whole number greater than 0.';

function positiveNumberError(value: string): string | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? undefined : POSITIVE_NUMBER_ERROR;
}

function positiveIntegerError(value: string): string | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? undefined : POSITIVE_INTEGER_ERROR;
}

export function validateAgentFlow(input: AgentFlowInput): AgentFlowValidation {
  const errors: AgentFlowValidation['errors'] = {};
  if (!input.name.trim()) errors.name = 'Enter an agent name.';

  const maxTurnsError = positiveIntegerError(input.maxTurns);
  const maxThinkingTokensError = positiveNumberError(input.maxThinkingTokens);
  const maxBudgetUsdError = positiveNumberError(input.maxBudgetUsd);
  if (maxTurnsError) errors.maxTurns = maxTurnsError;
  if (maxThinkingTokensError) errors.maxThinkingTokens = maxThinkingTokensError;
  if (maxBudgetUsdError) errors.maxBudgetUsd = maxBudgetUsdError;

  return { errors, saveBlocked: Object.keys(errors).length > 0 };
}

export function deriveAgentFlowReadiness(input: AgentFlowInput): AgentFlowReadiness {
  const { saveBlocked } = validateAgentFlow(input);
  const optionalImprovements = [
    !input.prompt.trim(),
    !input.model.trim(),
    input.atomsMode === 'inherit',
    !input.sandboxMode,
    !(input.subagentCallable || input.isPublic || input.a2aEnabled)
  ].filter(Boolean).length;

  return {
    label: saveBlocked ? 'Needs attention' : 'Ready to use',
    optionalImprovements,
    saveBlocked
  };
}

export function appendPromptGuidance(prompt: string, guidance: string): string {
  const normalizedGuidance = guidance.trim();
  if (!normalizedGuidance) return prompt;
  const lines = prompt.split('\n').map((line) => line.trim());
  if (lines.includes(normalizedGuidance)) return prompt;
  return prompt.trim() ? `${prompt.trimEnd()}\n\n${normalizedGuidance}` : normalizedGuidance;
}

function responseAvailability(input: AgentFlowInput): string | undefined {
  const surfaces = [
    input.subagentCallable ? 'other Monad agents' : null,
    input.isPublic ? 'public API' : null,
    input.a2aEnabled ? 'A2A' : null
  ].filter((value): value is string => Boolean(value));
  return surfaces.length > 0 ? `Available to: ${surfaces.join(', ')}` : undefined;
}

export function agentFlowSummaries(input: AgentFlowInput): Record<Exclude<AgentFlowNodeId, 'request'>, string[]> {
  const availability = responseAvailability(input);
  return {
    identity: [
      `Name: ${input.name.trim() || 'Add a name'}`,
      input.prompt.trim() ? 'Instructions: Configured' : 'Instructions: Add guidance'
    ],
    model: [`Model: ${input.model.trim() || 'workspace default'}`],
    tools: [
      input.atomsMode === 'inherit'
        ? 'Access: workspace capabilities'
        : `Access: ${input.atomsAllow.length} selected ${input.atomsAllow.length === 1 ? 'capability' : 'capabilities'}`
    ],
    safety: [`Safety: ${input.sandboxMode ? `${input.sandboxMode} sandbox` : 'workspace default'}`],
    response: [
      input.prompt.trim() ? 'Style: Follows agent instructions' : 'Style: Uses workspace defaults',
      input.prompt.trim() ? 'Preview: Follows configured guidance' : 'Preview: Add instructions to shape responses',
      availability
    ].filter((value): value is string => Boolean(value))
  };
}
