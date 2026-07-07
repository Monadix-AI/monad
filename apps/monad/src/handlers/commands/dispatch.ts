import type { CommandDefinition, CommandResult, CommandRunContext } from '@monad/sdk-atom';
import type { CommandRegistry } from './registry.ts';

import { parseSlashCommand } from '@monad/protocol';

export interface DispatchOptions {
  /** Called for a highRisk command before it runs; throw to deny (routes through oversight). */
  gate?(def: CommandDefinition): Promise<void>;
  /** Host-side policy hook for transport-specific command restrictions. */
  denyCommand?(def: CommandDefinition): CommandResult | null | undefined;
  /** Whether an agent turn is currently streaming for this session — gates non-`duringTurn` commands. */
  isBusy?: boolean;
}

/** Parse + resolve + run a slash command. Returns null when the text is not a slash command, names
 *  an unknown command, or names a skill — in all three cases the caller falls through to the loop
 *  (so skills still expand and plain text reaches the model). A resolved command may still be
 *  refused (busy) — that returns a CommandResult, not null. */
export async function dispatchCommand(
  registry: CommandRegistry,
  text: string,
  buildCtx: (args: string) => CommandRunContext,
  opts: DispatchOptions = {}
): Promise<CommandResult | null> {
  const parsed = parseSlashCommand(text);
  if (!parsed) return null;
  const entry = registry.resolve(parsed.name);
  if (!entry) return null;
  const denied = opts.denyCommand?.(entry.def);
  if (denied) return denied;
  // Concurrency guard: a command would otherwise race an in-flight turn (clear history mid-stream,
  // swap the model under a running loop…). Refuse unless the command opted into running during a turn.
  if (opts.isBusy && !entry.def.duringTurn) {
    return { message: `⏳ A turn is in progress — try /${entry.def.name} again when it finishes.` };
  }
  if (entry.def.highRisk && opts.gate) await opts.gate(entry.def);
  return entry.def.run(buildCtx(parsed.args), parsed.args);
}
