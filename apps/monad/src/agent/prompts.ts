// All model-facing prompt text the agent core emits, in one place. Tool/skill *descriptions*
// live with their definitions (they're part of the tool contract); this module holds the
// loop- and context-level prompts: the base system prompt, the skill L1 listing, the
// summarization prompt, and the small in-loop nudges/markers.

import type { LoadedSkill } from './loop/index.ts';

import { definePrompt } from './prompt-template.ts';
// `with { type: 'file' }` is the embed mechanism bun's --compile reliably bundles AND path-rewrites
// for the standalone binary; `Bun.file(new URL(..., import.meta.url))` resolves against the bundled
// module's relocated path and breaks in the compiled binary (ENOENT, notably on Windows).
import budgetExceededPath from './prompts/budget-exceeded-user.prompt.md' with { type: 'file' };
import contextSummaryPath from './prompts/context-summary-user.prompt.md' with { type: 'file' };
import customSystemEtaPath from './prompts/custom-system.prompt.md' with { type: 'file' };
import defaultSystemEtaPath from './prompts/default-system.prompt.md' with { type: 'file' };
import evictedToolResultPath from './prompts/evicted-tool-result-user.prompt.md' with { type: 'file' };
import handoffSystemPath from './prompts/handoff-system.prompt.md' with { type: 'file' };
import handoffUserPath from './prompts/handoff-user.prompt.md' with { type: 'file' };
import { OBSERVATION_PREFIX } from './prompts/short-text.ts';
import summaryReflectSystemPath from './prompts/summary-reflect-system.prompt.md' with { type: 'file' };
import summaryReflectUserPath from './prompts/summary-reflect-user.prompt.md' with { type: 'file' };
import summaryStructuredSystemPath from './prompts/summary-structured-system.prompt.md' with { type: 'file' };
import summarySystemPath from './prompts/summary-system.prompt.md' with { type: 'file' };
import summaryUserPath from './prompts/summary-user.prompt.md' with { type: 'file' };
import toolBudgetReachedPath from './prompts/tool-budget-reached-user.prompt.md' with { type: 'file' };

export { OBSERVATION_PREFIX };

const DEFAULT_SYSTEM_TEMPLATE = await definePrompt<{
  slots: SystemPromptSlots;
  skills: LoadedSkill[];
  toolNames: readonly string[];
}>({ id: 'agent.default-system', sourcePath: defaultSystemEtaPath });

const CUSTOM_SYSTEM_TEMPLATE = await definePrompt<{
  instructions: string;
  slots: SystemPromptSlots;
  skills: LoadedSkill[];
  toolNames: readonly string[];
}>({ id: 'agent.custom-system', sourcePath: customSystemEtaPath });

const SUMMARY_SYSTEM_TEMPLATE = await definePrompt({ id: 'agent.summary.system', sourcePath: summarySystemPath });
const SUMMARY_STRUCTURED_SYSTEM_TEMPLATE = await definePrompt<{ preserve: readonly string[] }>({
  id: 'agent.summary-structured.system',
  sourcePath: summaryStructuredSystemPath
});
const SUMMARY_REFLECT_SYSTEM_TEMPLATE = await definePrompt({
  id: 'agent.summary-reflect.system',
  sourcePath: summaryReflectSystemPath
});
const SUMMARY_USER_TEMPLATE = await definePrompt<{ prior?: string; transcript: string }>({
  id: 'agent.summary.user',
  sourcePath: summaryUserPath
});
const SUMMARY_REFLECT_USER_TEMPLATE = await definePrompt<{ summary: string }>({
  id: 'agent.summary-reflect.user',
  sourcePath: summaryReflectUserPath
});
const HANDOFF_SYSTEM_TEMPLATE = await definePrompt({ id: 'agent.handoff.system', sourcePath: handoffSystemPath });
const HANDOFF_USER_TEMPLATE = await definePrompt<{ prior?: string; transcript: string }>({
  id: 'agent.handoff.user',
  sourcePath: handoffUserPath
});
const CONTEXT_SUMMARY_TEMPLATE = await definePrompt<{ summary: string }>({
  id: 'agent.context-summary.user',
  sourcePath: contextSummaryPath
});
const TOOL_BUDGET_REACHED_TEMPLATE = await definePrompt({
  id: 'agent.tool-budget-reached.user',
  sourcePath: toolBudgetReachedPath
});
const BUDGET_EXCEEDED_TEMPLATE = await definePrompt({
  id: 'agent.budget-exceeded.user',
  sourcePath: budgetExceededPath
});
const EVICTED_TOOL_RESULT_TEMPLATE = await definePrompt<{ toolName: string; handle?: string }>({
  id: 'agent.evicted-tool-result.user',
  sourcePath: evictedToolResultPath
});

export const SUMMARY_PROMPT = SUMMARY_SYSTEM_TEMPLATE.render({});
export const SUMMARY_REFLECT_PROMPT = SUMMARY_REFLECT_SYSTEM_TEMPLATE.render({});
export const HANDOFF_PROMPT = HANDOFF_SYSTEM_TEMPLATE.render({});
export const TOOL_BUDGET_REACHED = TOOL_BUDGET_REACHED_TEMPLATE.render({});
export const BUDGET_EXCEEDED = BUDGET_EXCEEDED_TEMPLATE.render({});

export function renderSummaryStructuredSystemPrompt(preserve: readonly string[]): string {
  return SUMMARY_STRUCTURED_SYSTEM_TEMPLATE.render({ preserve });
}

export function renderSummaryUserPrompt(data: { prior?: string; transcript: string }): string {
  return SUMMARY_USER_TEMPLATE.render(data);
}

export function renderSummaryReflectUserPrompt(summary: string): string {
  return SUMMARY_REFLECT_USER_TEMPLATE.render({ summary });
}

export function renderHandoffUserPrompt(data: { prior?: string; transcript: string }): string {
  return HANDOFF_USER_TEMPLATE.render(data);
}

export function renderContextSummary(summary: string): string {
  return CONTEXT_SUMMARY_TEMPLATE.render({ summary });
}

/** `handle`, when given, is the tool-call id the full output was spilled under before eviction —
 *  point the model at read_tool_output instead of re-running the (possibly non-reproducible or
 *  side-effecting) call. */
export function evictedToolResult(toolName: string, handle?: string): string {
  return EVICTED_TOOL_RESULT_TEMPLATE.render({ toolName, handle });
}

/**
 * Ambient context the host knows about the run (none of which agent-core can introspect on its
 * own). Rendered into the system prompt so the model knows "when/where" it is. Extra keys are
 * allowed and rendered verbatim.
 */
export interface AgentEnvironment {
  date?: string;
  cwd?: string;
  os?: string;
  sandbox?: string;
  [key: string]: string | undefined;
}

/** Render the environment as a tagged block, or '' when there's nothing to show. */
export function renderEnvironment(env?: AgentEnvironment): string {
  if (!env) return '';
  const lines = Object.entries(env)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}: ${v}`);
  if (lines.length === 0) return '';
  return ['<environment>', ...lines, '</environment>'].join('\n');
}

export interface SystemPromptSlots {
  soul?: string;
  agent?: string;
  user?: string;
  environment?: string;
  summary?: string;
  injectedContext?: string;
}

export type UserPromptSlots = Pick<SystemPromptSlots, 'soul' | 'agent' | 'user'>;

export function renderAgentSystemPrompt(input: {
  instructions?: string;
  slots: SystemPromptSlots;
  skills: LoadedSkill[];
  toolNames: readonly string[];
}): string {
  if (!input.instructions) return DEFAULT_SYSTEM_TEMPLATE.render(input);
  const used = new Set<string>();
  const values: Record<string, string | undefined> = {
    SOUL: input.slots.soul,
    AGENT: input.slots.agent,
    USER: input.slots.user,
    ENVIRONMENT: input.slots.environment,
    SUMMARY: input.slots.summary,
    INJECTED_CONTEXT: input.slots.injectedContext,
    SKILLS: '',
    GUI_TRACK: ''
  };
  const instructions = input.instructions.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) => {
    if (!(key in values)) return match;
    used.add(key);
    return values[key] ?? '';
  });
  return CUSTOM_SYSTEM_TEMPLATE.render({
    instructions,
    skills: input.skills,
    toolNames: input.toolNames,
    slots: {
      soul: used.has('SOUL') ? undefined : input.slots.soul,
      agent: used.has('AGENT') ? undefined : input.slots.agent,
      user: used.has('USER') ? undefined : input.slots.user,
      environment: used.has('ENVIRONMENT') ? undefined : input.slots.environment,
      summary: used.has('SUMMARY') ? undefined : input.slots.summary,
      injectedContext: used.has('INJECTED_CONTEXT') ? undefined : input.slots.injectedContext
    }
  });
}
