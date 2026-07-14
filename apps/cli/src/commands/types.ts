import type { MonadClient } from '@monad/client';

type FlagType = 'string' | 'boolean' | 'number';

/** Declarative spec for a command-specific flag. Feeds both parsing and `monad completion`. */
export interface FlagSpec {
  type: FlagType;
  alias?: string; // short form, e.g. 'f' for --follow
  description: string;
  descriptionKey?: string;
}

/** Flags available to every command, parsed centrally in main.ts. */
export interface GlobalFlags {
  json: boolean;
  quiet: boolean;
  verbose: number;
  yes: boolean; // --yes / --no-input → assume yes / never prompt
  color: boolean;
  port?: number;
  host?: string;
  token?: string; // bearer token for --host remote connections
}

/** Context for commands that run without a daemon connection. */
interface LocalCommandContext {
  positionals: string[];
  flags: Record<string, unknown>;
  globals: GlobalFlags;
}

/** Everything a daemon command needs to run, assembled by the dispatcher. `positionals` are the
 *  args after the command name with flags stripped; command bodies read it as `args`. */
export interface CommandContext extends LocalCommandContext {
  client: MonadClient;
}

interface BaseCommandDef {
  name: string;
  aliases?: string[]; // hidden convenience aliases — resolved by the dispatcher, omitted from top-level usage
  hidden?: boolean; // omit from the top-level usage table (advanced/internal: acp, daemon)
  synopsis: string; // shown in usage table, e.g. "create <title>"
  description: string; // one-line description (authoring-language default)
  descriptionKey?: string; // i18n id for `description`, resolved against the active CLI locale
  flags?: Record<string, FlagSpec>; // command-specific flags (in addition to the global flags)
}

/** A command that runs without the daemon — skips resolveClientConn and MonadClient entirely. */
interface LocalCommandDef extends BaseCommandDef {
  local: true;
  run: (ctx: LocalCommandContext) => Promise<void>;
}

/** A command that requires a live daemon connection. */
interface DaemonCommandDef extends BaseCommandDef {
  local?: false;
  run: (ctx: CommandContext) => Promise<void>;
}

export type CommandDef = LocalCommandDef | DaemonCommandDef;

/** Stable exit codes — scripts depend on these (see docs/engineering/cli-design.md §3). */
export const EXIT = { OK: 0, ERROR: 1, USAGE: 2, CONFIG: 3, DAEMON: 4 } as const;

/** Error carrying a process exit code. Thrown by commands; mapped to process.exit in the entry. */
export class CliError extends Error {
  readonly code: number;
  constructor(message: string, code: number = EXIT.ERROR) {
    super(message);
    this.name = 'CliError';
    this.code = code;
  }
}

/** A usage error (bad args/flags) → exit code 2. Use for `usage: …` messages. */
export function usageError(message: string): CliError {
  return new CliError(message, EXIT.USAGE);
}

/** Map an unknown thrown value to a process exit code: CliError's own code, EXIT.DAEMON for a
 *  connection failure (daemon down/unreachable), else the generic error code. */
export function exitCodeFor(err: unknown): number {
  if (err instanceof CliError) return err.code;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (
    /econnrefused|unable to connect|fetch failed|failed to fetch|connection refused|connect timeout|socket/.test(msg)
  ) {
    return EXIT.DAEMON;
  }
  return EXIT.ERROR;
}
