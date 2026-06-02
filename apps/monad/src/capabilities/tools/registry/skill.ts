// The `skill` tool — monad's L2/L3 progressive-disclosure loader. The model calls it with an
// addressable skill id to pull that skill's body (L2 instructions) into the conversation over the
// JSON-action tool protocol. With a `file` argument it returns a bundled resource (L3) from
// the skill directory, so a skill can ship references/ and load them only when a task needs
// them. Built by the daemon as a factory over the discovered skills: it closes over the
// already-loaded, already-validated set.
// No scopes / not high-risk — it only returns text the operator already trusted at load.

import type { LoadedSkill, SkillTier } from '@/agent/loop/index.ts';
import type { Tool } from '@/capabilities/tools/types.ts';

import { isAbsolute, join, normalize } from 'node:path';
import { z } from 'zod';

import { substituteSkillDir } from '@/agent/loop/index.ts';
import { toolResult } from '@/capabilities/tools/types.ts';

/**
 * Runs a `context: fork` skill's body as an isolated subagent and returns its final answer.
 * `tier` is the skill's declared capability tier (resolved to a model by the routing layer).
 */
export type ForkRunner = (
  body: string,
  ctx: { sessionId: string; sandboxRoots?: string[] },
  tier?: SkillTier,
  /** The fork skill's name — surfaced to the SubagentStop hook so it can identify/rewrite the result. */
  name?: string
) => Promise<string>;

const skillInput = z.object({
  name: z.string().min(1).describe('Addressable id of the skill to load, e.g. global:summarize-changes'),
  file: z
    .string()
    .optional()
    .describe('Optional bundled resource path, relative to the skill dir (e.g. "references/API.md")')
});
type SkillToolInput = z.infer<typeof skillInput>;

/** Reject path-traversal / absolute escapes before touching the filesystem. The `file`
 *  arg is model-supplied (prompt-injectable), so it must stay within the skill dir. */
function resolveResource(dir: string, file: string): string {
  const rel = normalize(file);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${'/'}`) || rel.startsWith(`..${'\\'}`)) {
    throw new Error(`resource path "${file}" escapes the skill directory`);
  }
  return join(dir, rel);
}

/**
 * Build the `skill` tool over a set of loaded skills. run() returns the addressed skill's body,
 * or — with `file` — a bundled resource from the skill directory. Throws (surfaced to the
 * model as a tool error) for an unknown skill, a skill with no directory, an escaping path,
 * or a missing file. Skills flagged `modelInvocable:false` are excluded (user-only).
 *
 * `getSkills` is called live on each invocation, so the daemon's hot-reload watcher can mutate
 * the underlying array in place and the model immediately sees the updated set.
 */
export function createSkillTool(getSkills: () => LoadedSkill[], runFork?: ForkRunner): Tool<SkillToolInput, string> {
  return {
    name: 'skill',
    description:
      "Load a skill by addressable id. Call this when a task matches an available skill's description, then follow the returned instructions. Pass a `file` (relative path) to load a bundled resource the skill references.",
    scopes: [],
    inputSchema: skillInput,
    run: async ({ name, file }, ctx) => {
      const byName = new Map(
        getSkills()
          .filter((s) => s.modelInvocable !== false)
          .map((s) => [s.name, s])
      );
      const skill = byName.get(name);
      if (!skill) {
        const available = Array.from(byName.keys()).join(', ') || '(none)';
        throw new Error(`unknown skill "${name}". Available skills: ${available}`);
      }

      if (file !== undefined) {
        if (!skill.dir) throw new Error(`skill "${name}" has no directory; cannot load "${file}"`);
        const resource = Bun.file(resolveResource(skill.dir, file));
        if (!(await resource.exists())) throw new Error(`skill "${name}" has no bundled file "${file}"`);
        return toolResult(await resource.text());
      }

      // `context: fork` — run the body as an isolated subagent and hand back its result, so
      // the skill's multi-step work stays out of the main conversation.
      if (skill.fork && runFork) {
        const result = await runFork(substituteSkillDir(skill.body, skill.dir), ctx, skill.tier, name);
        return toolResult(`Ran skill "${name}" as an isolated subagent. Result:\n\n${result}`);
      }
      return toolResult(substituteSkillDir(skill.body, skill.dir));
    }
  };
}

import type { ToolModule } from './contract.ts';
// Uniform module entry.
export const register: ToolModule<{ getSkills: () => LoadedSkill[]; runFork?: ForkRunner }> = ({
  getSkills,
  runFork
}) => [createSkillTool(getSkills, runFork)];
