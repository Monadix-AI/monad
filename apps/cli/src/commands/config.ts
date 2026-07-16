import type { CommandDef } from './types.ts';

import { getPaths, loadConfig, saveAll } from '@monad/environment';

import { t } from '../lib/i18n.ts';
import { bold, cyan, dim, green, json, out, red } from '../lib/output.ts';
import { CliError, EXIT } from './types.ts';

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

// git-config-style configuration: read/write dotted keys in config.json, list everything, print the
// path, or open it in $EDITOR. Writes are re-validated by saveAll (a bad value fails with exit 3).
export const command: CommandDef = {
  local: true,
  name: 'config',
  synopsis: 'config <get|set|list|path|edit> [key] [value]',
  description: 'read or write configuration (e.g. monad config set network.transport uds)',
  descriptionKey: 'cli.cmd.config.desc',
  async run({ positionals }) {
    const [action, key, value] = positionals;
    const paths = getPaths();

    switch (action) {
      case 'path':
        out(paths.config);
        return;

      case 'list':
      case undefined: {
        const rows = flatten(await load());
        json(Object.fromEntries(rows));
        for (const [k, v] of rows) out(`${cyan(k)}${dim(' = ')}${typeof v === 'string' ? v : JSON.stringify(v)}`);
        return;
      }

      case 'get': {
        if (!key) throw new CliError('usage: monad config get <key>', EXIT.USAGE);
        const v = getByPath(await load(), key);
        if (v === undefined) throw new CliError(`${red('✖')} ${t('cli.config.noSuchKey', { key })}`, EXIT.USAGE);
        json(v);
        out(typeof v === 'string' ? v : JSON.stringify(v));
        return;
      }

      case 'set': {
        if (!key || value === undefined) throw new CliError('usage: monad config set <key> <value>', EXIT.USAGE);
        const cfg = await load();
        setByPath(cfg, key, value);
        try {
          await saveAll(paths, cfg as never);
        } catch (err) {
          throw new CliError(
            `${red('✖')} ${(err instanceof Error ? err.message : String(err)).split('\n')[0]}`,
            EXIT.CONFIG
          );
        }
        out(`${green('●')} ${cyan(key)}${dim(' = ')}${value}`);
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
