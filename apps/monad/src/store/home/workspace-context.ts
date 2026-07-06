import type { UserPromptSlots } from '@/agent/prompts.ts';

import { join } from 'node:path';
import { TEMPLATES, type TemplateName } from '@monad/home';

interface ContextFile {
  names: string[];
  template: TemplateName;
}

const CONTEXT_FILES = {
  soul: { names: ['SOUL.md'], template: 'SOUL.md' },
  agent: { names: ['AGENT.md', 'AGENTS.md'], template: 'AGENT.md' },
  user: { names: ['USER.md'], template: 'USER.md' }
} as const satisfies Record<keyof UserPromptSlots, ContextFile>;

async function readText(path: string): Promise<string | null> {
  try {
    return await Bun.file(path).text();
  } catch {
    return null;
  }
}

async function readTemplate(name: TemplateName): Promise<string> {
  return (await Bun.file(TEMPLATES[name]).text()).trim();
}

async function resolveSlot(workspace: string, entry: ContextFile): Promise<string> {
  for (const name of entry.names) {
    const content = await readText(join(workspace, name));
    const trimmed = content?.trim();
    if (trimmed) return trimmed;
    if (content !== null) break;
  }
  return readTemplate(entry.template);
}

/** The whitelisted workspace files (names only) — exported so a watcher can filter on them. */
export const WORKSPACE_CONTEXT_FILES: readonly string[] = Object.values(CONTEXT_FILES).flatMap((c) => c.names);

/** Resolve the user-editable prompt slots from workspace files, falling back to the shipped
 * templates so SOUL/AGENT/USER always have a default value even before customization. */
export async function loadWorkspacePromptSlots(workspace: string): Promise<UserPromptSlots> {
  return {
    soul: await resolveSlot(workspace, CONTEXT_FILES.soul),
    agent: await resolveSlot(workspace, CONTEXT_FILES.agent),
    user: await resolveSlot(workspace, CONTEXT_FILES.user)
  };
}

/** Backward-compatible joined view of the workspace prompt slots, in precedence order. */
async function _loadWorkspaceContext(workspace: string): Promise<string> {
  const slots = await loadWorkspacePromptSlots(workspace);
  return [slots.soul, slots.agent, slots.user].filter(Boolean).join('\n\n');
}
