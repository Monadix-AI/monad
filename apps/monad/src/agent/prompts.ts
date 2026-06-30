// All model-facing prompt text the agent core emits, in one place. Tool/skill *descriptions*
// live with their definitions (they're part of the tool contract); this module holds the
// loop- and context-level prompts: the base system prompt, the skill L1 listing, the
// summarization prompt, and the small in-loop nudges/markers.

import type { LoadedSkill } from './loop/index.ts';

// `with { type: 'file' }` is the embed mechanism bun's --compile reliably bundles AND path-rewrites
// for the standalone binary; `Bun.file(new URL(..., import.meta.url))` resolves against the bundled
// module's relocated path and breaks in the compiled binary (ENOENT, notably on Windows).
import defaultSystemPromptPath from './prompts/default-system-prompt.md' with { type: 'file' };
import handoffPromptPath from './prompts/handoff-prompt.md' with { type: 'file' };
import {
  BUDGET_EXCEEDED,
  GUI_TRACK_BOTH,
  GUI_TRACK_BROWSER,
  GUI_TRACK_COMPUTER,
  OBSERVATION_PREFIX,
  SKILL_INSTRUCTIONS_TEMPLATE,
  SUMMARY_MARKER,
  TOOL_BUDGET_REACHED
} from './prompts/short-text.ts';
import summaryPromptPath from './prompts/summary-prompt.md' with { type: 'file' };
import summaryReflectPromptPath from './prompts/summary-reflect-prompt.md' with { type: 'file' };

export { BUDGET_EXCEEDED, OBSERVATION_PREFIX, SUMMARY_MARKER, TOOL_BUDGET_REACHED };

/** Base persona/instructions when the host doesn't supply its own via `instructions`. */
export const DEFAULT_SYSTEM_PROMPT = (await Bun.file(defaultSystemPromptPath).text()).trim();

/** Instruction given to the (cheap) model that compacts old turns into the rolling summary. */
export const SUMMARY_PROMPT = (await Bun.file(summaryPromptPath).text()).trim();

/** Instruction for the reflector pass that condenses an over-grown rolling summary (GC). */
export const SUMMARY_REFLECT_PROMPT = (await Bun.file(summaryReflectPromptPath).text()).trim();

/** Instruction for the /handoff summary: a structured cross-session context block. */
export const HANDOFF_PROMPT = (await Bun.file(handoffPromptPath).text()).trim();

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
  skills?: string;
  guiTrack?: string;
  summary?: string;
  injectedContext?: string;
}

export type UserPromptSlots = Pick<SystemPromptSlots, 'soul' | 'agent' | 'user'>;

const SLOT_KEYS = {
  soul: 'SOUL',
  agent: 'AGENT',
  user: 'USER',
  environment: 'ENVIRONMENT',
  skills: 'SKILLS',
  guiTrack: 'GUI_TRACK',
  summary: 'SUMMARY',
  injectedContext: 'INJECTED_CONTEXT'
} as const satisfies Record<keyof SystemPromptSlots, string>;

/** Render a prompt template with explicit slot markers. Any non-empty slot omitted by the template
 * is appended to preserve the legacy "base prompt + addenda" behavior for older prompts. */
export function renderSystemPrompt(template: string, slots: SystemPromptSlots): string {
  const values = {
    [SLOT_KEYS.soul]: slots.soul?.trim(),
    [SLOT_KEYS.agent]: slots.agent?.trim(),
    [SLOT_KEYS.user]: slots.user?.trim(),
    [SLOT_KEYS.environment]: slots.environment?.trim(),
    [SLOT_KEYS.skills]: slots.skills?.trim(),
    [SLOT_KEYS.guiTrack]: slots.guiTrack?.trim(),
    [SLOT_KEYS.summary]: slots.summary?.trim(),
    [SLOT_KEYS.injectedContext]: slots.injectedContext?.trim()
  } as const;
  const used = new Set<string>();
  const rendered = template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) => {
    if (!(key in values)) return match;
    used.add(key);
    return values[key as keyof typeof values] ?? '';
  });
  const appended = Object.entries(values)
    .filter(([key, value]) => value && !used.has(key))
    .map(([, value]) => value);
  return [rendered.trim(), ...appended]
    .filter(Boolean)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * System-prompt addendum listing available skills (L1 progressive disclosure). Only
 * names + descriptions — the model pulls a body on demand via the `skill` tool. Skills
 * flagged `modelInvocable:false` are omitted (they stay user-only). Returns '' when no
 * skill is model-invocable, so the caller can skip the section entirely.
 */
/** Guidance for picking the right GUI-automation track when those tools are present. Emitted only
 *  when a `browser__*` and/or `computer__*` toolset is available, so the model favours the cheaper,
 *  more reliable, more contained browser track and reserves real-desktop control for what it can't
 *  reach otherwise. */
export function guiTrackInstructions(toolNames: readonly string[]): string {
  const hasBrowser = toolNames.some((n) => n.startsWith('browser__'));
  const hasComputer = toolNames.some((n) => n.startsWith('computer__'));
  if (!hasBrowser && !hasComputer) return '';
  if (hasBrowser && hasComputer) return GUI_TRACK_BOTH;
  if (hasComputer) return GUI_TRACK_COMPUTER;
  return GUI_TRACK_BROWSER;
}

export function skillInstructions(skills: LoadedSkill[]): string {
  const visible = skills.filter((s) => s.modelInvocable !== false);
  if (visible.length === 0) return '';
  const list = visible.map((s) => JSON.stringify({ skill_id: s.name, description: s.description })).join('\n');
  return SKILL_INSTRUCTIONS_TEMPLATE.replace('{{SKILL_LIST}}', list);
}
