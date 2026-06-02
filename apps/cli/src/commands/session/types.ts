import type { CommandContext, FlagSpec } from '../types.ts';

export interface SessionCommandDef {
  name: string;
  aliases?: string[];
  synopsis: string;
  description: string;
  descriptionKey?: string; // i18n id for `description`, resolved in the session usage table
  flags?: Record<string, FlagSpec>;
  run: (ctx: CommandContext) => Promise<void>;
}
