import type { SandboxMode } from '@monad/protocol';

export type AgentFlowNodeId = 'identity' | 'models' | 'tools' | 'skills' | 'memory' | 'sandbox' | 'channels';

export const AGENT_FLOW_NODE_IDS = [
  'identity',
  'models',
  'tools',
  'skills',
  'memory',
  'sandbox',
  'channels'
] as const satisfies readonly AgentFlowNodeId[];

export interface AgentInstructionDraft {
  agent: string;
  user: string;
}

type FlowTranslate = (key: string, params?: Record<string, string | number>) => string;

export interface AgentFlowInput {
  a2aEnabled: boolean;
  atomsAllow: string[];
  atomsMode: 'inherit' | 'allowlist';
  isPublic: boolean;
  maxBudgetUsd: string;
  maxThinkingTokens: string;
  maxTurns: string;
  model: string;
  roles: Record<string, string>;
  name: string;
  instructions: AgentInstructionDraft;
  mcpCount: number;
  memory: { available: boolean; factCount: number };
  sandboxMode: SandboxMode | '';
  skillsAllow: string[];
  skillsMode: 'inherit' | 'allowlist';
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
    !Object.values(input.instructions).some((value) => value.trim()),
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

function copy(
  translate: FlowTranslate | undefined,
  key: string,
  fallback: string,
  params?: Record<string, string | number>
): string {
  return translate ? translate(key, params) : fallback;
}

function channelAvailability(input: AgentFlowInput, translate?: FlowTranslate): string {
  const surfaces = [
    input.subagentCallable ? copy(translate, 'web.studio.agentEditor.summary.subagents', 'subagents') : null,
    input.isPublic ? copy(translate, 'web.studio.agentEditor.summary.publicApi', 'public API') : null,
    input.a2aEnabled ? 'A2A' : null
  ].filter((value): value is string => Boolean(value));
  return surfaces.length > 0
    ? copy(translate, 'web.studio.agentEditor.summary.availableTo', `Available to: ${surfaces.join(', ')}`, {
        surfaces: surfaces.join(', ')
      })
    : copy(translate, 'web.studio.agentEditor.summary.private', 'Availability: private');
}

function instructionSummary(instructions: AgentInstructionDraft, translate?: FlowTranslate): string {
  const files = [instructions.agent.trim() ? 'AGENT.md' : null, instructions.user.trim() ? 'USER.md' : null].filter(
    (value): value is string => Boolean(value)
  );
  return files.length > 0
    ? copy(translate, 'web.studio.agentEditor.summary.instructions', `Instructions: ${files.join(', ')}`, {
        files: files.join(', ')
      })
    : copy(translate, 'web.studio.agentEditor.summary.addInstructions', 'Instructions: Add Markdown');
}

function executionLimitSummary(input: AgentFlowInput, translate?: FlowTranslate): string | undefined {
  const limits = [
    input.maxTurns.trim()
      ? copy(translate, 'web.studio.agentEditor.summary.maxTurnsLimit', `Max turns ${input.maxTurns.trim()}`, {
          value: input.maxTurns.trim()
        })
      : null,
    input.maxThinkingTokens.trim()
      ? copy(
          translate,
          'web.studio.agentEditor.summary.tokenBudgetLimit',
          `Token budget ${input.maxThinkingTokens.trim()}`,
          { value: input.maxThinkingTokens.trim() }
        )
      : null,
    input.maxBudgetUsd.trim()
      ? copy(translate, 'web.studio.agentEditor.summary.costLimit', `Cost limit $${input.maxBudgetUsd.trim()}`, {
          value: input.maxBudgetUsd.trim()
        })
      : null
  ].filter((value): value is string => Boolean(value));
  if (limits.length === 0) return undefined;
  return copy(translate, 'web.studio.agentEditor.summary.limits', `Limits: ${limits.join(', ')}`, {
    limits: limits.join(', ')
  });
}

export function agentFlowSummaries(
  input: AgentFlowInput,
  translate?: FlowTranslate
): Record<AgentFlowNodeId, string[]> {
  const roleOverrides = Object.keys(input.roles).length;
  const limits = executionLimitSummary(input, translate);
  const name = input.name.trim() || copy(translate, 'web.studio.agentEditor.summary.addName', 'Add a name');
  const profile =
    input.model.trim() || copy(translate, 'web.studio.agentEditor.summary.workspaceDefault', 'workspace default');
  return {
    identity: [
      copy(translate, 'web.studio.agentEditor.summary.name', `Name: ${name}`, { name }),
      instructionSummary(input.instructions, translate)
    ],
    models: [
      copy(translate, 'web.studio.agentEditor.summary.profile', `Profile: ${profile}`, { profile }),
      roleOverrides
        ? copy(translate, 'web.studio.agentEditor.summary.roleOverrides', `Role overrides: ${roleOverrides}`, {
            count: roleOverrides
          })
        : copy(translate, 'web.studio.agentEditor.summary.noRoleOverrides', 'Role overrides: none'),
      ...(limits ? [limits] : [])
    ],
    tools: [
      input.atomsMode === 'inherit'
        ? copy(translate, 'web.studio.agentEditor.summary.inheritPolicy', 'Policy: inherit workspace')
        : copy(
            translate,
            'web.studio.agentEditor.summary.selectedTools',
            `Policy: ${input.atomsAllow.length} selected ${input.atomsAllow.length === 1 ? 'tool' : 'tools'}`,
            { count: input.atomsAllow.length }
          ),
      copy(translate, 'web.studio.agentEditor.summary.inheritedMcps', `MCPs: ${input.mcpCount} inherited`, {
        count: input.mcpCount
      })
    ],
    skills: [
      input.skillsMode === 'inherit'
        ? copy(translate, 'web.studio.agentEditor.summary.inheritPolicy', 'Policy: inherit workspace')
        : copy(
            translate,
            'web.studio.agentEditor.summary.selectedSkills',
            `Policy: ${input.skillsAllow.length} selected`,
            { count: input.skillsAllow.length }
          )
    ],
    memory: [
      input.memory.available
        ? copy(translate, 'web.studio.agentEditor.summary.memoryAvailable', 'Memory: available')
        : copy(translate, 'web.studio.agentEditor.summary.memoryUnavailable', 'Memory: unavailable'),
      copy(translate, 'web.studio.agentEditor.summary.facts', `Facts: ${input.memory.factCount}`, {
        count: input.memory.factCount
      })
    ],
    sandbox: [
      copy(
        translate,
        'web.studio.agentEditor.summary.sandbox',
        `Sandbox: ${input.sandboxMode || 'workspace default'}`,
        {
          mode:
            input.sandboxMode || copy(translate, 'web.studio.agentEditor.summary.workspaceDefault', 'workspace default')
        }
      )
    ],
    channels: [channelAvailability(input, translate)]
  };
}
