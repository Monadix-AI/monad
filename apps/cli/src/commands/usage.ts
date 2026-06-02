import type { CommandDef } from './types.ts';

import { t } from '../lib/i18n.ts';
import { bold, cyan, dim, green, json, out } from '../lib/output.ts';
import { requireTreatyData } from '../lib/treaty.ts';
import { usageError } from './types.ts';

const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
const num = (n: number) => n.toLocaleString();

// `reset` is a subcommand, not a flag: wiping the ledger is a mutation and must read as one.
export const command: CommandDef = {
  name: 'usage',
  group: 'configure',
  synopsis: 'usage <show|reset> [--by-day] [--by-category]',
  subcommands: ['show', 'reset'],
  description: 'show cumulative token and cost usage (the global ledger), or wipe it',
  descriptionKey: 'cli.cmd.usage.desc',
  flags: {
    'by-day': { type: 'boolean', description: 'collapse breakdown by day', descriptionKey: 'cli.usage.flag.byDay' },
    'by-category': {
      type: 'boolean',
      description: 'collapse breakdown by category',
      descriptionKey: 'cli.usage.flag.byCategory'
    }
  },
  async run({ positionals, flags, client }) {
    const [action = 'show'] = positionals;
    if (action === 'reset') {
      requireTreatyData(await client.treaty.v1.usage.reset.post());
      out(green(t('cli.usageCmd.reset')));
      return;
    }
    if (action !== 'show' && action !== 'list') throw usageError(t('cli.usage.unknownAction', { action }));

    const result = requireTreatyData(await client.treaty.v1.usage.get());
    json(result);
    const { totalCostUsd, totalInputTokens, totalOutputTokens, entries, breakdown } = result;

    if (entries.length === 0) {
      out(dim(t('cli.usageCmd.empty')));
      return;
    }

    // --by-day / --by-category collapse the full breakdown onto one dimension instead of the
    // default per-provider/model rollup.
    const dim2 = flags['by-day'] ? 'day' : flags['by-category'] ? 'category' : null;
    if (dim2) {
      const groups = new Map<string, { in: number; out: number; cost: number }>();
      for (const r of breakdown) {
        const g = groups.get(r[dim2]) ?? { in: 0, out: 0, cost: 0 };
        g.in += r.inputTokens;
        g.out += r.outputTokens;
        g.cost += r.costUsd;
        groups.set(r[dim2], g);
      }
      out(bold(t('cli.usageCmd.title')) + dim(t('cli.usageCmd.titleHint')));
      for (const [k, g] of groups) {
        out(`  ${cyan(k)}  ${dim(t('cli.usageCmd.inOut', { in: num(g.in), out: num(g.out) }))}  ${bold(usd(g.cost))}`);
      }
      out(dim('  ─────'));
      out(
        `  ${bold(t('cli.usageCmd.total'))}  ` +
          dim(t('cli.usageCmd.inOut', { in: num(totalInputTokens), out: num(totalOutputTokens) })) +
          `  ${bold(usd(totalCostUsd))}`
      );
      return;
    }

    out(bold(t('cli.usageCmd.title')) + dim(t('cli.usageCmd.titleHint')));
    for (const e of entries) {
      const cache = e.cacheReadTokens > 0 ? dim(t('cli.usageCmd.cacheRead', { n: num(e.cacheReadTokens) })) : '';
      out(
        `  ${cyan(`${e.provider}/${e.model}`)}  ` +
          dim(t('cli.usageCmd.inOut', { in: num(e.inputTokens), out: num(e.outputTokens) })) +
          cache +
          `  ${bold(usd(e.costUsd))}`
      );
    }
    out(dim('  ─────'));
    out(
      `  ${bold(t('cli.usageCmd.total'))}  ` +
        dim(t('cli.usageCmd.inOut', { in: num(totalInputTokens), out: num(totalOutputTokens) })) +
        `  ${bold(usd(totalCostUsd))}`
    );
  }
};
