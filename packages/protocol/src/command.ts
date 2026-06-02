// Slash commands — single source of truth for the parser and the wire spec.
//
// Two kinds share one mechanism (see docs + apps/monad/src/modules/commands):
//   - 'builtin' : host-run, no LLM turn (e.g. /new, /reset, /model). First-party built-ins and
//                 third-party atom pack commands both register here; built-ins win on name conflicts.
//   - 'prompt'  : a user-invocable skill whose body expands into the prompt (handled in the loop).
//
// The parser is the ONE definition; the loop, the channel adapter, and the web client all derive
// from it instead of re-implementing the regex.

import { z } from 'zod';

/** Parse `/<name> [args]` → { name, args }, or null when the text is not a slash command.
 *  Name is lowercase-with-hyphens, with optional `.` command qualification or `:` skill instance
 *  qualification such as `global:name`, `atom-pack:pack:name`, or `agent:agent:name`.
 *  args is the untrimmed remainder. */
export function parseSlashCommand(text: string): { name: string; args: string } | null {
  const token = '[a-z0-9]+(?:-[a-z0-9]+)*';
  const m = new RegExp(`^/(${token}(?:(?:\\.|:)${token}){0,2})(?:\\s+([\\s\\S]*))?$`).exec(text.trim());
  return m ? { name: m[1] as string, args: m[2] ?? '' } : null;
}

export const commandKindSchema = z.enum(['builtin', 'prompt']);
export type CommandKind = z.infer<typeof commandKindSchema>;

export const commandSourceSchema = z.enum(['builtin', 'atom', 'skill']);
export type CommandSource = z.infer<typeof commandSourceSchema>;

/** The advertised shape of one command — used by every client's discovery surface
 *  (ACP available_commands_update, web autocomplete, /help, CLI). */
export const commandSpecSchema = z.object({
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  /** Localized when a translator + descriptionKey are available; else the authoring default. */
  description: z.string(),
  /** i18n message id for `description` (built-ins set this); resolved at list() time. */
  descriptionKey: z.string().optional(),
  /** Hint for the argument the command expects, e.g. "<number|session-id>". */
  argHint: z.string().optional(),
  version: z.string().optional(),
  icon: z.string().optional(),
  kind: commandKindSchema,
  source: commandSourceSchema,
  /** Set when source === 'atom'. */
  atomName: z.string().optional(),
  /** false → host doesn't meet the command's gates; shown disabled (mirrors skill `available`). */
  available: z.boolean().default(true)
});
export type CommandSpec = z.infer<typeof commandSpecSchema>;

export const commandsListResponseSchema = z.object({ commands: z.array(commandSpecSchema) });
export type CommandsListResponse = z.infer<typeof commandsListResponseSchema>;
