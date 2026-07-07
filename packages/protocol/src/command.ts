// Slash commands — single source of truth for the parser and the wire spec.
//
// Two item types share one discovery surface:
//   - 'action': host-run slash command, no LLM turn (e.g. /new, /reset, /model, atom-pack commands)
//   - 'skill' : a user-invocable skill whose body expands into the prompt (handled in the loop)
//
// The parser is the ONE definition; the loop, the channel adapter, and the web client all derive
// from it instead of re-implementing the regex.

import { z } from 'zod';

/** Parse `/<name> [args]` → { name, args }, or null when the text is not a slash command.
 *  Name is lowercase-with-hyphens, with optional `.` command qualification or `:` skill instance
 *  qualification such as `global:name`, `atom-pack:pack:name`, or `agent:agent:name`.
 *  args is the untrimmed remainder after the command token. */
export function parseSlashCommand(text: string): { name: string; args: string } | null {
  const token = '[a-z0-9]+(?:-[a-z0-9]+)*';
  const trimmed = text.trim();
  const m = new RegExp(`^/(${token}(?:(?:\\.|:)${token}){0,2})(?:\\s+([\\s\\S]*))?$`).exec(trimmed);
  return m ? { name: m[1] as string, args: m[2] ?? '' } : null;
}

export const commandItemTypeSchema = z.enum(['action', 'skill']);
export type CommandItemType = z.infer<typeof commandItemTypeSchema>;

export const commandSourceSchema = z.enum(['builtin', 'atom-pack', 'custom']);
export type CommandSource = z.infer<typeof commandSourceSchema>;

export const commandsListFilterSchema = z.enum(['all', 'enabled', 'disabled']);
export type CommandsListFilter = z.infer<typeof commandsListFilterSchema>;

export const commandsListQuerySchema = z.object({ filter: commandsListFilterSchema.optional() });
export type CommandsListQuery = z.infer<typeof commandsListQuerySchema>;
export type CommandsListQueryInput = { filter?: CommandsListFilter };

export const commandArgTypeSchema = z.enum(['string', 'enum', 'model', 'session', 'path', 'boolean', 'number']);
export type CommandArgType = z.infer<typeof commandArgTypeSchema>;

export const commandArgValueSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional()
});
export type CommandArgValue = z.infer<typeof commandArgValueSchema>;

export const commandArgSchema = z.object({
  name: z.string(),
  type: commandArgTypeSchema,
  required: z.boolean().optional(),
  repeated: z.boolean().optional(),
  description: z.string().optional(),
  placeholder: z.string().optional(),
  values: z.array(commandArgValueSchema).optional()
});
export type CommandArg = z.infer<typeof commandArgSchema>;

export const commandSubcommandSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  aliases: z.array(z.string()).default([]),
  args: z.array(commandArgSchema).optional()
});
export type CommandSubcommand = z.infer<typeof commandSubcommandSchema>;

/** The advertised shape of one slash item — used by every client's discovery surface
 *  (ACP available_commands_update, web autocomplete, /help, CLI). */
export const commandItemSchema = z.object({
  /** Canonical slash token without the leading slash; clients insert/execute `/${id}`. */
  id: z.string(),
  /** Human-friendly display label. */
  name: z.string(),
  type: commandItemTypeSchema,
  source: commandSourceSchema,
  /** Atom-pack id, custom scope/owner, or other source label when available. */
  sourceName: z.string().optional(),
  /** Localized when a translator + descriptionKey are available; else the authoring default. */
  description: z.string(),
  aliases: z.array(z.string()).default([]),
  /** Hint for the argument the command expects, e.g. "<number|session-id>". */
  argHint: z.string().optional(),
  args: z.array(commandArgSchema).optional(),
  subcommands: z.array(commandSubcommandSchema).optional(),
  version: z.string().optional(),
  icon: z.string().optional(),
  /** false → host doesn't meet the item's gates; hidden by default from list responses. */
  enabled: z.boolean().default(true)
});
export type CommandItem = z.infer<typeof commandItemSchema>;

export const commandsListResponseSchema = z.object({ commands: z.array(commandItemSchema) });
export type CommandsListResponse = z.infer<typeof commandsListResponseSchema>;
