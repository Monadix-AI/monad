import type { CommandDef } from './types.ts';

import { generateRemoteToken, getPaths, loadConfig, saveAll } from '@monad/environment';

import { t } from '../lib/i18n.ts';
import { confirmInsecureRemoteAccess } from '../lib/network-security.ts';
import { bold, cyan, dim, green, isStructured, json, out, red, yellow } from '../lib/output.ts';
import { redactSecrets } from '../lib/redact.ts';
import { CliError, EXIT, usageError } from './types.ts';

type Json = Record<string, unknown>;

/** Flatten a nested config object to dotted `a.b.c` → value entries (arrays kept as values). */
function flatten(obj: Json, prefix = ''): Array<[string, unknown]> {
  const rows: Array<[string, unknown]> = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) rows.push(...flatten(v as Json, key));
    else rows.push([key, v]);
  }
  return rows;
}

function getByPath(obj: Json, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Json)[k] : undefined), obj);
}

/** Set a dotted path, coercing the string value to boolean/number where unambiguous. */
function setByPath(obj: Json, path: string, raw: string): void {
  const keys = path.split('.');
  const last = keys.pop();
  if (!last) throw new CliError(t('cli.config.invalidKey'), EXIT.USAGE);
  let cur: Json = obj;
  for (const k of keys) {
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k] as Json;
  }
  cur[last] = raw === 'true' ? true : raw === 'false' ? false : /^-?\d+$/.test(raw) ? Number(raw) : raw;
}

async function load(): Promise<Json> {
  const cfg = await loadConfig(getPaths());
  if (!cfg) throw new CliError(`${red('✖')} ${t('cli.config.noConfig', { cmd: bold('monad init') })}`, EXIT.CONFIG);
  return cfg as unknown as Json;
}

/**
 * Reads are masked by default. `--reveal` prints raw values, but only to an interactive terminal:
 * the ways a secret actually escapes are a redirect into a file, a pipe into a log, and a `--json`
 * capture — all of which are exactly the non-TTY case.
 */
function revealed(flags: Record<string, unknown>): boolean {
  if (flags.reveal !== true) return false;
  if (!process.stdout.isTTY || isStructured()) throw usageError(t('cli.config.revealNeedsTty'));
  return true;
}

// git-config-style configuration: read/write dotted keys in config.json, list everything, print the
// path, or open it in $EDITOR. Writes are re-validated by saveAll (a bad value fails with exit 3).
export const command: CommandDef = {
  local: true,
  name: 'config',
  group: 'configure',
  synopsis: 'config <get|set|list|path|edit> [key] [value]',
  subcommands: ['get', 'set', 'list', 'path', 'edit'],
  description: 'read or write configuration (e.g. monad config set network.transport uds)',
  descriptionKey: 'cli.cmd.config.desc',
  flags: {
    reveal: {
      type: 'boolean',
      description: 'print secret values unmasked; refused unless stdout is a terminal',
      descriptionKey: 'cli.config.flag.reveal'
    }
  },
  async run({ globals, positionals, flags }) {
    const [action, key, value] = positionals;
    const reveal = revealed(flags);
    const paths = getPaths();

    switch (action) {
      case 'path':
        out(paths.config);
        return;

      case 'list':
      case undefined: {
        const cfg = await load();
        const rows = flatten(reveal ? cfg : redactSecrets(cfg));
        json(Object.fromEntries(rows));
        for (const [k, v] of rows) out(`${cyan(k)}${dim(' = ')}${typeof v === 'string' ? v : JSON.stringify(v)}`);
        if (!reveal) out(dim(t('cli.config.maskedHint')));
        return;
      }

      case 'get': {
        if (!key) throw new CliError('usage: monad config get <key>', EXIT.USAGE);
        const raw = getByPath(await load(), key);
        if (raw === undefined) throw new CliError(`${red('✖')} ${t('cli.config.noSuchKey', { key })}`, EXIT.USAGE);
        const v = reveal ? raw : redactSecrets(raw, key.split('.').at(-1) ?? '');
        json(v);
        out(typeof v === 'string' ? v : JSON.stringify(v));
        return;
      }

      case 'set': {
        if (!key || value === undefined) throw new CliError('usage: monad config set <key> <value>', EXIT.USAGE);
        const cfg = await load();
        const network = cfg.network as Json;
        const remoteAccess = network.remoteAccess as Json;
        const https = network.https as Json;
        const wasRemoteEnabled = remoteAccess.enabled === true;
        const wasInsecureRemote = wasRemoteEnabled && https.enabled === false;
        setByPath(cfg, key, value);
        if (key === 'network.remoteAccess.enabled' && value === 'true' && !wasRemoteEnabled) {
          https.enabled = true;
          if (typeof remoteAccess.token !== 'string' || !remoteAccess.token) remoteAccess.token = generateRemoteToken();
        }
        const enablesInsecureRemote = remoteAccess.enabled === true && https.enabled === false && !wasInsecureRemote;
        if (enablesInsecureRemote) {
          out(`${red(bold(t('cli.remote.httpWarningTitle')))}  ${t('cli.remote.httpWarning')}`);
          if (!(await confirmInsecureRemoteAccess(globals.yes))) {
            out(yellow(t('cli.aborted')));
            return;
          }
        }
        try {
          await saveAll(paths, cfg as never);
        } catch (err) {
          throw new CliError(
            `${red('✖')} ${(err instanceof Error ? err.message : String(err)).split('\n')[0]}`,
            EXIT.CONFIG
          );
        }
        // Echo the same masked form a read would give: `config set … <api key>` otherwise prints
        // the secret straight back to stdout.
        out(`${green('●')} ${cyan(key)}${dim(' = ')}${redactSecrets(value, key.split('.').at(-1) ?? '')}`);
        return;
      }

      case 'edit': {
        // biome-ignore lint/suspicious/noUndeclaredEnvVars: standard editor env vars
        const editor = Bun.env.EDITOR || Bun.env.VISUAL || 'vi';
        const proc = Bun.spawn([editor, paths.config], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
        process.exitCode = await proc.exited;
        return;
      }

      default:
        throw new CliError('usage: monad config <get|set|list|path|edit> [key] [value]', EXIT.USAGE);
    }
  }
};
