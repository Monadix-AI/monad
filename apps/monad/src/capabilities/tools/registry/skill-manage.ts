// HIGH-RISK by design: skill_manage writes executable instruction files the agent will later
// follow, so every call routes through the oversight gate —
// the agent proposes, a human approves. Writes are validated by writeSkill (parseSkillMd +
// name/path guards) and the daemon's ReloadService makes them live without a restart.

import type { Tool, ToolInputSchema } from '@/capabilities/tools/types.ts';

import { join } from 'node:path';

import { scanSkillFiles } from '@/capabilities/skills/install/scan.ts';
import { toolResult } from '@/capabilities/tools/types.ts';
import { deleteSkill, patchSkill, removeSkillResource, writeSkill, writeSkillResource } from '@/store/home/skills.ts';

const ACTIONS = ['create', 'edit', 'patch', 'delete', 'write_file', 'remove_file'] as const;
type SkillAction = (typeof ACTIONS)[number];

interface SkillManageInput {
  action: SkillAction;
  name: string;
  /** Full SKILL.md content for create/edit. */
  content?: string;
  /** patch: the unique substring to replace. */
  oldString?: string;
  /** patch: its replacement. */
  newString?: string;
  /** write_file/remove_file: bundled resource path relative to the skill dir. */
  file?: string;
}

const skillManageInput: ToolInputSchema<SkillManageInput> = {
  safeParse(input: unknown) {
    const o = (input ?? {}) as Record<string, unknown>;
    if (!ACTIONS.includes(o.action as SkillAction)) {
      return { success: false, error: `"action" must be one of: ${ACTIONS.join(', ')}` };
    }
    if (typeof o.name !== 'string' || o.name.length === 0) {
      return { success: false, error: '"name" is required' };
    }
    const optStr = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
    return {
      success: true,
      data: {
        action: o.action as SkillAction,
        name: o.name,
        content: optStr('content'),
        oldString: optStr('oldString'),
        newString: optStr('newString'),
        file: optStr('file')
      }
    };
  }
};

// Per-action argument requirements are enforced in run() — the schema only checks the common shape.
export function createSkillManageTool(skillsDir: string): Tool<SkillManageInput, string> {
  return {
    name: 'skill_manage',
    description:
      'Author your own skills (procedural memory): save a reusable, non-trivial workflow so you can reuse it later. action: create|edit (provide full SKILL.md `content`), patch (`oldString`→`newString`), delete, write_file/remove_file (bundled `file`). Names are lowercase-with-hyphens; create/edit `content` must have valid `---` frontmatter with name + description, and the frontmatter name must equal `name`.',
    scopes: [],
    highRisk: true,
    inputSchema: skillManageInput,
    run: async ({ action, name, content, oldString, newString, file }) => {
      switch (action) {
        case 'create':
        case 'edit': {
          if (content === undefined) throw new Error(`action "${action}" requires "content" (the full SKILL.md)`);
          const dir = await writeSkill(skillsDir, name, content);
          const enc = new TextEncoder();
          const warnings = scanSkillFiles(new Map([[`${name}/SKILL.md`, enc.encode(content)]]));
          const warn = warnings.length > 0 ? `\nAdvisory: ${warnings.join('; ')}` : '';
          return toolResult(`skill "${name}" saved (${dir})${warn}`);
        }
        case 'patch': {
          if (oldString === undefined || newString === undefined) {
            throw new Error('action "patch" requires "oldString" and "newString"');
          }
          await patchSkill(skillsDir, name, oldString, newString);
          const patched = await Bun.file(join(skillsDir, name, 'SKILL.md')).bytes();
          const warnings = scanSkillFiles(new Map([[`${name}/SKILL.md`, patched]]));
          const warn = warnings.length > 0 ? `\nAdvisory: ${warnings.join('; ')}` : '';
          return toolResult(`skill "${name}" patched${warn}`);
        }
        case 'delete':
          await deleteSkill(skillsDir, name);
          return toolResult(`skill "${name}" deleted`);
        case 'write_file': {
          if (file === undefined || content === undefined) {
            throw new Error('action "write_file" requires "file" and "content"');
          }
          await writeSkillResource(skillsDir, name, file, content);
          const enc = new TextEncoder();
          const warnings = scanSkillFiles(new Map([[`${name}/${file}`, enc.encode(content)]]));
          const warn = warnings.length > 0 ? `\nAdvisory: ${warnings.join('; ')}` : '';
          return toolResult(`wrote "${file}" in skill "${name}"${warn}`);
        }
        case 'remove_file': {
          if (file === undefined) throw new Error('action "remove_file" requires "file"');
          await removeSkillResource(skillsDir, name, file);
          return toolResult(`removed "${file}" from skill "${name}"`);
        }
        default: {
          const unreachable: never = action;
          throw new Error(`unknown action: ${String(unreachable)}`);
        }
      }
    }
  };
}

import type { ToolModule } from './contract.ts';
// Uniform module entry.
export const register: ToolModule<{ skillsDir: string }> = ({ skillsDir }) => [createSkillManageTool(skillsDir)];
