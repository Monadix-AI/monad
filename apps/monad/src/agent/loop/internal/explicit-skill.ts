import type { PersistedModelInputOverride } from '../replay.ts';
import type { LoadedSkill } from '../types.ts';

import { parseSlashCommand } from '@monad/protocol';

export interface ExplicitSkill {
  skill: LoadedSkill;
  argString: string;
}

/** Resolve a user-invocable skill token. Built-in host commands are start-only, but skills may
 * appear inline so the user can write natural text around the explicit skill selection. */
export function resolveExplicitSkill(skills: LoadedSkill[], userText: string): ExplicitSkill | null {
  const parsed = parseSlashCommand(userText);
  if (parsed) {
    const skill = skills.find((s) => s.name === parsed.name);
    if (skill && skill.userInvocable !== false) return { skill, argString: parsed.args };
  }

  const token = '[a-z0-9]+(?:-[a-z0-9]+)*';
  const skillRef = new RegExp(`(^|\\s)/(${token}(?::${token}){1,2})(?=\\s|$)`, 'g');
  for (const match of userText.matchAll(skillRef)) {
    const skillName = match[2] as string;
    const skill = skills.find((s) => s.name === skillName);
    if (!skill || skill.userInvocable === false) continue;
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    const before = userText.slice(0, start).trim();
    const after = userText.slice(start + skillName.length + 1).trim();
    return { skill, argString: [before, after].filter(Boolean).join('\n\n') };
  }
  return null;
}

export function skillModelInput(skillName: string, text: string): PersistedModelInputOverride {
  return { modelInput: { kind: 'skill', skillName, text } };
}
