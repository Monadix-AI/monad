#!/usr/bin/env bun

import { readFileSync } from 'node:fs';
import { checkDaemonVersion, MonadClient } from '@monad/client';
import { openUrl, resolveClientConn } from '@monad/home';
import { setLogLevel } from '@monad/logger';
import { MONAD_VERSION } from '@monad/protocol';
import cac from 'cac';

import { commands } from './commands/index.ts';
import { CliError, type CommandDef, EXIT, exitCodeFor, type GlobalFlags } from './commands/types.ts';
import { interactionSourceLabel, startCliInteractionPresenter } from './interactions/presenter.ts';
import { startDaemon } from './lib/daemon.ts';
import { initCliI18n, t } from './lib/i18n.ts';
import { runBrowserInit } from './lib/init-flow.ts';
import { bold, cyan, dim, isJson, out, red, setOutputMode, yellow } from './lib/output.ts';

// Visible (non-hidden) commands, in registration order — the source for the usage table.
const visibleCommands = commands.filter((c) => !c.hidden);

// Localized against the active CLI locale; call fresh after initCliI18n() so language changes apply.
function buildUsage(): string {
  const localCmds = visibleCommands.filter((c) => c.local);
  const daemonCmds = visibleCommands.filter((c) => !c.local);
  const colWidth = Math.max(...visibleCommands.map((c) => c.synopsis.length)) + 2;
  const row = (c: (typeof visibleCommands)[number]) => {
    const desc = c.descriptionKey ? t(c.descriptionKey) : c.description;
    return `  ${bold(c.synopsis.padEnd(colWidth))}${desc}`;
  };
  return [
    `${bold('monad')} <command>`,
    '',
    `${bold(t('cli.usage.localCommands'))}`,
    ...localCmds.map(row),
    '',
    `${bold(t('cli.usage.daemonCommands'))}`,
    ...daemonCmds.map(row),
    '',
    `  ${bold('-V, --version'.padEnd(colWidth))}${t('cli.usage.version')}`,
    `  ${bold('-v, --verbose'.padEnd(colWidth))}${t('cli.usage.verbose')}`,
    `  ${bold('--json'.padEnd(colWidth))}${t('cli.usage.json')}`,
    `  ${bold('-q, --quiet'.padEnd(colWidth))}${t('cli.usage.quiet')}`,
    `  ${bold('--debug'.padEnd(colWidth))}${t('cli.usage.debug')}`,
    '',
    `${bold(t('cli.usage.environment'))}`,
    `  ${bold('MONAD_PORT'.padEnd(colWidth))}${t('cli.usage.portDesc', { example: cyan('MONAD_PORT=8000 monad') })}`,
    `  ${bold('MONAD_HOME'.padEnd(colWidth))}${t('cli.usage.homeDesc')}`,
    '',
    dim(t('cli.usage.portNote')),
    dim(t('cli.usage.remoteNote'))
  ].join('\n');
}

/** Per-command help: synopsis, localized description, aliases, and the declared flags. */
function renderCommandHelp(cmd: CommandDef): string {
  const lines = [`${bold(`monad ${cmd.synopsis}`)}`, '', cmd.descriptionKey ? t(cmd.descriptionKey) : cmd.description];
  if (cmd.aliases?.length) lines.push('', `${dim('aliases:')} ${cmd.aliases.join(', ')}`);
  const flagEntries = Object.entries(cmd.flags ?? {});
  if (flagEntries.length) {
    lines.push('', bold('Flags:'));
    for (const [name, spec] of flagEntries) {
      const head = `${spec.alias ? `-${spec.alias}, ` : ''}--${name}`;
      lines.push(`  ${bold(head.padEnd(18))}${spec.descriptionKey ? t(spec.descriptionKey) : spec.description}`);
    }
  }
  return lines.join('\n');
}

/** English snapshot built at import time (the active locale defaults to English before initCliI18n).
 *  Live output uses `buildUsage()` directly so a non-English locale is reflected. */
export const USAGE_TEXT = buildUsage();

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
    .option('--token <token>', 'bearer token for remote --host connections');
}

function countVerbose(verboseOpt: unknown): number {
  return Array.isArray(verboseOpt) ? verboseOpt.length : verboseOpt ? 1 : 0;
}

export async function main(): Promise<void> {
  // Resolve the active CLI locale (config + language packs) before emitting any text.
  await initCliI18n();

  const rawArgs = process.argv.slice(2);
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
    token: typeof opts.token === 'string' ? opts.token : undefined
  };
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
    out(target ? renderCommandHelp(target) : buildUsage());
    return;
  }
  if (opts.help === true) {
    const cmd = command ? registry.get(command) : undefined;
    out(cmd ? renderCommandHelp(cmd) : buildUsage());
    return;
  }

  const flags = Object.fromEntries(Object.entries(opts).filter(([k]) => !GLOBAL_OPTION_KEYS.has(k)));

  // Resolve the command before deciding whether to connect to the daemon.
  const cmd = command ? registry.get(command) : undefined;
  if (command && !cmd) {
    out(buildUsage());
    throw new CliError('', EXIT.USAGE);
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
      if (!rawArgs.includes('--force')) throw new CliError('', EXIT.ERROR);
      out(yellow(t('cli.err.forceContinue')));
    }
  }

  const client = new MonadClient({ baseUrl: conn.baseUrl, token: token ?? undefined, unixSocket: conn.unixSocket });

  if (!command) {
    await startDaemon();
    const statusResult = await client.treaty.v1.init.status.get();
    if (statusResult.data && !statusResult.data.initialized) {
      const port = parseInt(new URL(conn.baseUrl).port || '52749', 10);
      await runBrowserInit(client, port);
    } else {
      const url = `${conn.baseUrl.replace(/\/$/, '')}/`;
      out(cyan(url));
      if (process.stdout.isTTY) openUrl(url);
    }
    return;
  }

  // cmd is defined (daemon command) — command && !cmd was handled above.
  const interactive = process.stdin.isTTY && process.stdout.isTTY && !globals.json && opts.input !== false;
  const stopInteractionPresenter = interactive
    ? startCliInteractionPresenter(client, {
        onPresent: (interaction) =>
          out(`\nRequested by ${interactionSourceLabel(interaction.source)}\n${interaction.request.title}`),
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
  const file = Bun.env.MONAD_AGENT_TOKEN_FILE;
  if (!file) return null;
  try {
    const token = readFileSync(file, 'utf8').trim();
    return token || null;
  } catch {
    return null;
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
  else if (!url.port) url.port = new URL(conn.baseUrl).port || '52749';
  return { baseUrl: url.origin, unixSocket: undefined };
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    const code = exitCodeFor(err);
    const message = err instanceof Error ? err.message : String(err);
    // In structured-output mode emit a machine-readable error to stderr so pipelines can parse it.
    if (isJson()) {
      process.stderr.write(`${JSON.stringify({ error: message || 'unknown error', code })}\n`);
    } else if (message) {
      process.stderr.write(`${message}\n`);
    }
    process.exit(code);
  });
}
