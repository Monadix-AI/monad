#!/usr/bin/env bun

import { readFileSync } from 'node:fs';
import { checkDaemonVersion, MonadClient } from '@monad/client';
import { resolveClientConn } from '@monad/environment';
import { setLogLevel } from '@monad/logger';
import { MONAD_VERSION } from '@monad/protocol';
import cac from 'cac';

import { commands } from './commands/index.ts';
import { CliError, type CommandDef, EXIT, exitCodeFor, FLAG_COL, type GlobalFlags } from './commands/types.ts';
import { interactionProducerLabel, startCliInteractionPresenter } from './interactions/presenter.ts';
import { DaemonError } from './lib/daemon-error.ts';
import { initCliI18n, t } from './lib/i18n.ts';
import { startAndOpenWeb } from './lib/open-web.ts';
import { bold, cyan, dim, green, isJson, out, red, setOutputMode, yellow } from './lib/output.ts';

// Visible (non-hidden) commands, in registration order — the source for the usage table.
const visibleCommands = commands.filter((c) => !c.hidden);

const USAGE_SECTIONS = [
  { group: 'daemon', titleKey: 'cli.usage.group.daemon' },
  { group: 'work', titleKey: 'cli.usage.group.work' },
  { group: 'configure', titleKey: 'cli.usage.group.configure' }
] as const;

// Localized against the active CLI locale; call fresh after initCliI18n() so language changes apply.
function buildUsage(): string {
  // Clamped so one long synopsis cannot push every description off the right edge; a synopsis that
  // overflows the column gets its description on the next line instead.
  const colWidth = Math.min(Math.max(...visibleCommands.map((c) => c.synopsis.length)) + 2, 46);
  const row = (c: (typeof visibleCommands)[number]) => {
    const desc = c.descriptionKey ? t(c.descriptionKey) : c.description;
    if (c.synopsis.length + 2 > colWidth) return `  ${colorSynopsis(c.synopsis)}\n  ${' '.repeat(colWidth)}${desc}`;
    return `  ${colorSynopsis(c.synopsis.padEnd(colWidth))}${desc}`;
  };
  const sections = USAGE_SECTIONS.flatMap(({ group, titleKey }) => {
    const rows = visibleCommands.filter((c) => (c.group ?? 'configure') === group).map(row);
    return rows.length ? [bold(cyan(t(titleKey))), ...rows, ''] : [];
  });
  return [
    `${bold('monad')} ${cyan('<command>')}`,
    '',
    ...sections,
    `  ${bold(cyan('-V, --version'.padEnd(colWidth)))}${t('cli.usage.version')}`,
    `  ${bold(cyan('-v, --verbose'.padEnd(colWidth)))}${t('cli.usage.verbose')}`,
    `  ${bold(cyan('--json'.padEnd(colWidth)))}${t('cli.usage.json')}`,
    `  ${bold(cyan('-q, --quiet'.padEnd(colWidth)))}${t('cli.usage.quiet')}`,
    `  ${bold(cyan('--debug'.padEnd(colWidth)))}${t('cli.usage.debug')}`,
    `  ${bold(cyan('--force'.padEnd(colWidth)))}${t('cli.usage.force')}`,
    `  ${bold(cyan('--token-file'.padEnd(colWidth)))}${t('cli.usage.tokenFile')}`,
    '',
    `${bold(cyan(t('cli.usage.environment')))}`,
    `  ${bold(green('MONAD_PORT'.padEnd(colWidth)))}${t('cli.usage.portDesc', { example: cyan('MONAD_PORT=8000 monad') })}`,
    `  ${bold(green('MONAD_HOME'.padEnd(colWidth)))}${t('cli.usage.homeDesc')}`,
    '',
    dim(t('cli.usage.portNote')),
    dim(t('cli.usage.remoteNote'))
  ].join('\n');
}

function colorSynopsis(synopsis: string): string {
  const separator = synopsis.indexOf(' ');
  if (separator === -1) return bold(green(synopsis));
  return `${bold(green(synopsis.slice(0, separator)))}${cyan(synopsis.slice(separator))}`;
}

/** Per-command help: synopsis, localized description, aliases, and the declared flags. */
function renderCommandHelp(cmd: CommandDef): string {
  const lines = [
    `${bold('monad')} ${colorSynopsis(cmd.synopsis)}`,
    '',
    cmd.descriptionKey ? t(cmd.descriptionKey) : cmd.description
  ];
  if (cmd.aliases?.length) lines.push('', `${dim('aliases:')} ${cmd.aliases.join(', ')}`);
  const flagEntries = Object.entries(cmd.flags ?? {});
  if (flagEntries.length) {
    lines.push('', bold(cyan(t('cli.usage.flags'))));
    for (const [name, spec] of flagEntries) {
      const head = `${spec.alias ? `-${spec.alias}, ` : ''}--${name}`;
      lines.push(
        `  ${bold(cyan(head.padEnd(FLAG_COL)))}${spec.descriptionKey ? t(spec.descriptionKey) : spec.description}`
      );
    }
  }
  return lines.join('\n');
}

const registry = new Map(commands.flatMap((c) => [[c.name, c], ...(c.aliases ?? []).map((a) => [a, c] as const)]));

function isRemoteUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1';
  } catch {
    return false;
  }
}

// Keys cac assigns to the global flags below — stripped from a command's own `flags` bag.
const GLOBAL_OPTION_KEYS = new Set([
  '--',
  'version',
  'V',
  'help',
  'h',
  'json',
  'quiet',
  'q',
  'verbose',
  'v',
  'color',
  'yes',
  'y',
  'input', // from --no-input
  'output',
  'o',
  'port',
  'host',
  'token',
  'token-file',
  'tokenFile',
  'force',
  'debug'
]);

/** cac is used purely as a tokenizer: it parses global flags and separates positionals from
 *  flags. Help/version are rendered by us (localized), so cac's built-ins are intentionally unused. */
function buildParser() {
  return cac('monad')
    .option('-V, --version', 'print version')
    .option('-h, --help', 'show help')
    .option('--json', 'machine-readable output')
    .option('-q, --quiet', 'suppress non-essential output')
    .option('-v, --verbose', 'more detail (repeatable)')
    .option('--no-color', 'disable color')
    .option('-y, --yes', 'assume yes')
    .option('--no-input', 'never prompt')
    .option('-o, --output <format>', 'output format: table | json | yaml')
    .option('--port <port>', 'daemon port for this call')
    .option('--host <host>', 'daemon host for this call')
    .option('--token <token>', 'bearer token for remote --host connections')
    .option('--token-file <path>', 'read the bearer token from a file instead of argv')
    .option('--force', 'continue past a daemon/client version mismatch');
}

function countVerbose(verboseOpt: unknown): number {
  return Array.isArray(verboseOpt) ? verboseOpt.length : verboseOpt ? 1 : 0;
}

export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  // Resolve the active CLI locale (config + language packs) before emitting any text. `__complete`
  // emits raw ids only and runs on every TAB press, so it skips the locale scan entirely.
  if (rawArgs[0] !== '__complete') await initCliI18n();

  const parsed = buildParser().parse(['', '', ...rawArgs], { run: false });
  const opts = parsed.options as Record<string, unknown>;

  const debug = rawArgs.includes('--debug');
  const verbose = countVerbose(opts.verbose);
  setLogLevel(debug || verbose >= 2 ? 'debug' : 'silent');

  const globals: GlobalFlags = {
    json: opts.json === true,
    quiet: opts.quiet === true,
    verbose,
    yes: opts.yes === true || opts.input === false,
    color: opts.color !== false,
    port: typeof opts.port === 'number' ? opts.port : opts.port ? Number(opts.port) : undefined,
    host: typeof opts.host === 'string' ? opts.host : undefined,
    // Prefer the file: a token in argv is readable by every local user through `ps` and lands in
    // the shell history file.
    token:
      readTokenFile(opts['token-file'] ?? opts.tokenFile) ?? (typeof opts.token === 'string' ? opts.token : undefined)
  };
  // A silently-ignored `-o jsonl` would feed human text into a JSON parser, so an unknown format is
  // a usage error. `table` is the human renderer's public name.
  if (opts.output !== undefined && !['json', 'yaml', 'table'].includes(String(opts.output))) {
    process.stderr.write(`${t('cli.err.badOutputFormat', { value: String(opts.output) })}\n`);
    process.exit(EXIT.USAGE);
  }
  const fmt = opts.output === 'json' || opts.output === 'yaml' || opts.output === 'table' ? opts.output : undefined;
  setOutputMode({
    color: globals.color,
    quiet: globals.quiet,
    json: globals.json,
    format: fmt === 'table' ? 'human' : fmt
  });

  if (opts.version === true) {
    process.stdout.write(`${MONAD_VERSION}\n`);
    return;
  }

  const [command, ...positionals] = parsed.args as string[];

  // Help is always available without a daemon.
  if (command === 'help') {
    const target = positionals[0] ? registry.get(positionals[0]) : undefined;
    const sub = target?.subHelp?.(positionals.slice(1));
    out(sub ?? (target ? renderCommandHelp(target) : buildUsage()));
    return;
  }
  if (opts.help === true) {
    const cmd = command ? registry.get(command) : undefined;
    const sub = cmd?.subHelp?.(positionals);
    out(sub ?? (cmd ? renderCommandHelp(cmd) : buildUsage()));
    return;
  }

  const flags = Object.fromEntries(Object.entries(opts).filter(([k]) => !GLOBAL_OPTION_KEYS.has(k)));

  // Resolve the command before deciding whether to connect to the daemon.
  const cmd = command ? registry.get(command) : undefined;
  if (command && !cmd) {
    out(buildUsage());
    throw new CliError('', EXIT.USAGE);
  }

  const localSubcommand = positionals[0];
  if (cmd?.runLocal && localSubcommand && cmd.localSubcommands?.includes(localSubcommand)) {
    await cmd.runLocal({ positionals, flags, globals });
    return;
  }

  // Local commands run entirely without a daemon connection.
  if (cmd?.local) {
    await cmd.run({ positionals, flags, globals });
    return;
  }

  // All remaining commands (and the no-command default) require a live daemon connection.
  const { baseUrl, token: configToken, unixSocket } = await resolveClientConn();
  const envConn = Bun.env.MONAD_SERVER_URL ? { baseUrl: Bun.env.MONAD_SERVER_URL, unixSocket: undefined } : null;
  const conn = applyConnOverride(envConn ?? { baseUrl, unixSocket }, globals);
  // --token overrides the config token (used when --host points to a remote daemon with its own auth).
  const token = globals.token ?? readAgentTokenFile() ?? configToken;

  // Version check for remote connections only — local daemon is always same build.
  if (isRemoteUrl(conn.baseUrl)) {
    const result = await checkDaemonVersion(conn.baseUrl, token ?? undefined);
    if (!result.compatible) {
      out(
        `${red(t('cli.err.versionMismatch'))}  ${t('cli.err.daemonClient', {
          daemon: bold(result.daemonVersion),
          client: bold(result.clientVersion)
        })}\n${dim(`  ${t('cli.err.forceHint')}`)}`
      );
      if (opts.force !== true) throw new CliError(t('cli.err.versionMismatch'), EXIT.ERROR);
      out(yellow(t('cli.err.forceContinue')));
    }
  }

  const client = new MonadClient({ baseUrl: conn.baseUrl, token: token ?? undefined, unixSocket: conn.unixSocket });

  if (!command) {
    await startAndOpenWeb(client, conn.baseUrl);
    return;
  }

  // cmd is defined (daemon command) — command && !cmd was handled above.
  const interactive = process.stdin.isTTY && process.stdout.isTTY && !globals.json && opts.input !== false;
  const stopInteractionPresenter = interactive
    ? startCliInteractionPresenter(client, {
        onPresent: (interaction) =>
          out(`\nRequested by ${interactionProducerLabel(interaction.source)}\n${interaction.request.title}`),
        onError: (error) => process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      })
    : undefined;
  try {
    await cmd?.run({ positionals, flags, globals, client });
  } finally {
    await stopInteractionPresenter?.();
  }
}

function readAgentTokenFile(): string | null {
  return readTokenFile(Bun.env.MONAD_AGENT_TOKEN_FILE) ?? null;
}

/** Read a bearer token from a file path. Unlike the env-var variant this is user-supplied, so an
 *  unreadable path is a usage error rather than a silent fall-through to no token. */
function readTokenFile(path: unknown): string | undefined {
  if (typeof path !== 'string' || !path) return undefined;
  try {
    return readFileSync(path, 'utf8').trim() || undefined;
  } catch {
    throw new CliError(t('cli.err.tokenFileUnreadable', { path }), EXIT.USAGE);
  }
}

/** Honor per-invocation --host/--port overrides. --host may be a bare host or a full URL (with an
 *  https scheme for remote daemons); the bearer token is preserved by the caller. */
function applyConnOverride(
  conn: { baseUrl: string; unixSocket?: string },
  globals: GlobalFlags
): { baseUrl: string; unixSocket?: string } {
  if (globals.port === undefined && globals.host === undefined) return conn;
  const raw = globals.host ?? '127.0.0.1';
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  if (globals.port !== undefined) url.port = String(globals.port);
  else if (!url.port) url.port = new URL(conn.baseUrl).port || '47749';
  return { baseUrl: url.origin, unixSocket: undefined };
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    const code = exitCodeFor(err);
    const message = err instanceof Error ? err.message : String(err);
    // In structured-output mode emit a machine-readable error to stderr so pipelines can parse it.
    // A daemon failure contributes its own descriptor (code/requestId/retryable) alongside the
    // process exit code, so a pipeline can branch on the cause, not just on "it failed".
    if (isJson()) {
      const frame =
        err instanceof DaemonError
          ? { ...err.toJSON(), exitCode: code }
          : { error: message || 'unknown error', exitCode: code };
      process.stderr.write(`${JSON.stringify(frame)}\n`);
    } else if (message && !(err instanceof CliError && err.reported)) {
      process.stderr.write(`${message}\n`);
    }
    process.exit(code);
  });
}
