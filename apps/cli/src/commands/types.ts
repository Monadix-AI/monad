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
export interface LocalCommandContext {
  positionals: string[];
  flags: Record<string, unknown>;
  globals: GlobalFlags;
}

/** Everything a daemon command needs to run, assembled by the dispatcher. `positionals` are the
 *  args after the command name with flags stripped; command bodies read it as `args`. */
export interface CommandContext extends LocalCommandContext {
  client: MonadClient;
}

/** Usage-table section. Groups the surface by what the reader is trying to do, not by whether the
 *  command happens to need a daemon connection. */
type CommandGroup = 'daemon' | 'work' | 'configure';

interface BaseCommandDef {
  name: string;
  aliases?: string[]; // hidden convenience aliases — resolved by the dispatcher, omitted from top-level usage
  hidden?: boolean; // omit from the top-level usage table (advanced/internal: acp, daemon)
  group?: CommandGroup; // usage-table section; defaults to 'configure'
  synopsis: string; // shown in usage table, e.g. "create <title>"
  // Second-level verbs this command dispatches on. The single source for shell completion — declare
  // it here rather than restating the list in the completion generator.
  subcommands?: string[];
  description: string; // one-line description (authoring-language default)
  descriptionKey?: string; // i18n id for `description`, resolved against the active CLI locale
  flags?: Record<string, FlagSpec>; // command-specific flags (in addition to the global flags)
  // A command that dispatches to subcommands can render localized help for one of them, so
  // `monad <cmd> <sub> --help` (and `monad help <cmd> <sub>`) reaches the sub's own help.
  subHelp?: (args: string[]) => string | undefined;
  localSubcommands?: readonly string[];
  runLocal?: (ctx: LocalCommandContext) => Promise<void>;
}

/** A command that runs without the daemon — skips resolveClientConn and MonadClient entirely. */
export interface LocalCommandDef extends BaseCommandDef {
  local: true;
  run: (ctx: LocalCommandContext) => Promise<void>;
}

/** A command that requires a live daemon connection. */
interface DaemonCommandDef extends BaseCommandDef {
  local?: false;
  run: (ctx: CommandContext) => Promise<void>;
}

export type CommandDef = LocalCommandDef | DaemonCommandDef;

/** Width of the flag-name column in per-command help; wide enough for the longest declared flag. */
export const FLAG_COL = 22;

/** Stable exit codes — scripts depend on these (see docs/internal/development/cli-design.md §3). */
export const EXIT = { OK: 0, ERROR: 1, USAGE: 2, CONFIG: 3, DAEMON: 4 } as const;

/** Error carrying a process exit code. Thrown by commands; mapped to process.exit in the entry. */
export class CliError extends Error {
  readonly code: number;
  /** The command already wrote this outcome to stdout as its result; the entry point must not
   *  echo the same line to stderr. The message still feeds the `--json` error frame. */
  readonly reported: boolean;
  constructor(message: string, code: number = EXIT.ERROR, opts?: { reported?: boolean }) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.reported = opts?.reported ?? false;
  }
}

/** Map an HTTP status to the stable exit-code contract (docs/internal/development/cli-design.md §3). */
function exitCodeForHttpStatus(status: number): number {
  // 502/503/504 mean the daemon is not answering — same condition as a refused connection.
  if (status === 502 || status === 503 || status === 504) return EXIT.DAEMON;
  if (status === 400 || status === 404 || status === 405 || status === 422) return EXIT.USAGE;
  if (status === 409 || status === 412) return EXIT.CONFIG;
  return EXIT.ERROR;
}

/** A usage error (bad args/flags) → exit code 2. Use for `usage: …` messages. */
export function usageError(message: string): CliError {
  return new CliError(message, EXIT.USAGE);
}

/** Map an unknown thrown value to a process exit code: CliError's own code, the daemon's HTTP
 *  status when the failure came from a daemon call, EXIT.DAEMON for a transport-level connection
 *  failure, else the generic error code. The message regex is the last resort — it only sees
 *  errors that never reached the daemon (fetch/socket failures), which carry no status. */
export function exitCodeFor(err: unknown): number {
  if (err instanceof CliError) return err.code;
  if (err instanceof Error && err.name === 'DaemonError') {
    const status = (err as Error & { status?: number }).status;
    if (typeof status === 'number') return exitCodeForHttpStatus(status);
  }
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (
    /econnrefused|unable to connect|fetch failed|failed to fetch|connection refused|connect timeout|socket/.test(msg)
  ) {
    return EXIT.DAEMON;
  }
  return EXIT.ERROR;
}
