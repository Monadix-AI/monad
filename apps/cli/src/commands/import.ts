import type { ImportSettingsApplyResult, ImportSettingsPreview, ImportSettingsSource } from '@monad/protocol';
import type { CommandDef } from './types.ts';

import { cyan, dim, green, json, out, red, yellow } from '../lib/output.ts';
import { CliError, EXIT } from './types.ts';

function requireTreatyData<T>(result: { data: T | null; status: number }): T {
  if (result.data === null) throw new Error(`request failed: ${result.status}`);
  return result.data;
}

function valueFlag(flags: Record<string, unknown>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

function boolFlag(flags: Record<string, unknown>, name: string): boolean {
  return flags[name] === true;
}

function splitSet(value: string | undefined): Set<string> | null {
  if (!value) return null;
  return new Set(
    value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
  );
}

function filteredPreview(preview: ImportSettingsPreview, flags: Record<string, unknown>): ImportSettingsPreview {
  const categories = splitSet(valueFlag(flags, 'only'));
  const risks = splitSet(valueFlag(flags, 'risk'));
  if (!categories && !risks) return preview;
  return {
    ...preview,
    items: preview.items.filter(
      (item) => (!categories || categories.has(item.category)) && (!risks || risks.has(item.risk))
    )
  };
}

async function maybeSavePreview(preview: ImportSettingsPreview, flags: Record<string, unknown>): Promise<void> {
  const path = valueFlag(flags, 'save-preview');
  if (!path) return;
  await Bun.write(path, `${JSON.stringify(preview, null, 2)}\n`);
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value.padEnd(width);
  if (width <= 3) return value.slice(0, width);
  return `${value.slice(0, width - 3)}...`;
}

function actionCell(action: string, width: number): string {
  const value = truncate(action, width);
  if (action === 'add' || action === 'update') return green(value);
  if (action === 'conflict' || action === 'manual') return yellow(value);
  return red(value);
}

function tableWidths(items: ImportSettingsPreview['items']) {
  const columns = Math.max(88, Math.min(process.stdout.columns || 112, 140));
  const id = Math.min(24, Math.max(10, ...items.map((item) => item.id.length)));
  const action = 9;
  const risk = 7;
  const target = Math.min(36, Math.max(18, ...items.map((item) => item.target.length)));
  const reason = Math.max(24, columns - id - action - risk - target - 13);
  return { id, action, risk, target, reason };
}

function printItemTable(items: ImportSettingsPreview['items']): void {
  const widths = tableWidths(items);
  out(
    `${dim(truncate('id', widths.id))}  ${dim(truncate('action', widths.action))}  ${dim(
      truncate('risk', widths.risk)
    )}  ${dim(truncate('target', widths.target))}  ${dim(truncate('reason', widths.reason))}`
  );
  out(
    dim(
      `${'-'.repeat(widths.id)}  ${'-'.repeat(widths.action)}  ${'-'.repeat(widths.risk)}  ${'-'.repeat(
        widths.target
      )}  ${'-'.repeat(widths.reason)}`
    )
  );
  for (const item of items) {
    out(
      `${cyan(truncate(item.id, widths.id))}  ${actionCell(item.action, widths.action)}  ${truncate(
        item.risk,
        widths.risk
      )}  ${truncate(item.target, widths.target)}  ${truncate(item.reason, widths.reason)}`
    );
    if (item.summary) {
      out(`${' '.repeat(widths.id + widths.action + widths.risk + widths.target + 8)}${dim(item.summary)}`);
    }
  }
}

function printPreview(preview: ImportSettingsPreview): void {
  out(`${green('●')} import preview ${dim(`from ${preview.from}`)} ${cyan(preview.path)}`);
  for (const warning of preview.warnings) out(`${yellow('!')} ${warning}`);
  if (preview.items.length === 0) {
    out(dim('No importable settings found.'));
    return;
  }
  const categories = [...new Set(preview.items.map((item) => item.category))];
  for (const category of categories) {
    const items = preview.items.filter((item) => item.category === category);
    out('');
    out(`${cyan(category)} ${dim(`(${items.length})`)}`);
    printItemTable(items);
  }
}

function printResult(result: ImportSettingsApplyResult): void {
  printPreview(result.preview);
  out('');
  for (const id of result.applied) out(`${green('✓')} applied ${cyan(id)}`);
  for (const item of result.skipped) out(`${yellow('!')} skipped ${cyan(item.id)} ${dim(item.reason)}`);
}

function doctorReport(preview: ImportSettingsPreview) {
  return {
    from: preview.from,
    path: preview.path,
    items: preview.items.length,
    warnings: preview.warnings,
    actions: Object.fromEntries(
      ['add', 'update', 'skip', 'conflict', 'manual'].map((a) => [
        a,
        preview.items.filter((i) => i.action === a).length
      ])
    ),
    risks: Object.fromEntries(
      ['low', 'medium', 'high'].map((r) => [r, preview.items.filter((i) => i.risk === r).length])
    )
  };
}

export const command: CommandDef = {
  name: 'import',
  synopsis: 'import settings|doctor --from <source> --path <path> [--apply]',
  description: 'preview or import explicit local settings from Codex, Claude Code, Hermes, or OpenClaw',
  flags: {
    from: {
      type: 'string',
      description:
        'source: auto | codex | claude-code | hermes | openclaw | cursor | claude-desktop | vscode | aider | continue | roo-code; auto inspects only the provided path'
    },
    path: {
      type: 'string',
      description: 'explicit local file or directory to read; no parent-dir, home-dir, or network scanning'
    },
    apply: { type: 'boolean', description: 'write selected preview items; omitted means dry-run preview only' },
    select: { type: 'string', description: 'comma-separated preview item ids to apply from the current preview' },
    'all-safe': {
      type: 'boolean',
      description: 'apply only low-risk add items; skips manual, conflict, update, and high-risk items'
    },
    replace: {
      type: 'boolean',
      description: 'allow updates for conflicting existing settings; credentials still do not overwrite'
    },
    only: {
      type: 'string',
      description: 'filter preview output to comma-separated categories, for example mcpServers,skills'
    },
    risk: {
      type: 'string',
      description: 'filter preview output to comma-separated risks: low,medium,high'
    },
    'save-preview': {
      type: 'string',
      description: 'write the complete unfiltered preview JSON to a local file'
    }
  },
  async run({ positionals, flags, client }) {
    const [sub] = positionals;
    if (sub !== 'settings' && sub !== 'doctor') {
      throw new CliError('usage: monad import settings|doctor --from <source> --path <path>', EXIT.USAGE);
    }
    const path = valueFlag(flags, 'path');
    if (!path) throw new CliError('usage: monad import settings|doctor --from <source> --path <path>', EXIT.USAGE);
    const from = (valueFlag(flags, 'from') ?? 'auto') as ImportSettingsSource;
    const replace = boolFlag(flags, 'replace');
    const base = { from, path, replace };

    if (sub === 'doctor') {
      const preview = requireTreatyData<ImportSettingsPreview>(
        await client.treaty.v1.settings.import.preview.post(base)
      );
      const report = doctorReport(preview);
      json(report);
      out(`${green('●')} import doctor ${dim(`from ${preview.from}`)} ${cyan(preview.path)}`);
      out(
        `  items=${report.items} add=${report.actions.add} manual=${report.actions.manual} conflict=${report.actions.conflict}`
      );
      out(`  risk low=${report.risks.low} medium=${report.risks.medium} high=${report.risks.high}`);
      for (const warning of preview.warnings) out(`${yellow('!')} ${warning}`);
      return;
    }

    if (boolFlag(flags, 'apply')) {
      const select = (valueFlag(flags, 'select') ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
      const allSafe = boolFlag(flags, 'all-safe');
      if (!allSafe && select.length === 0) {
        throw new CliError('usage: monad import settings --apply --select <id,...> or --all-safe', EXIT.USAGE);
      }
      const preview = requireTreatyData<ImportSettingsPreview>(
        await client.treaty.v1.settings.import.preview.post(base)
      );
      await maybeSavePreview(preview, flags);
      const selected = allSafe ? preview.items : preview.items.filter((item) => select.includes(item.id));
      const hashes = Object.fromEntries(selected.map((item) => [item.id, item.hash]));
      const result = requireTreatyData<ImportSettingsApplyResult>(
        await client.treaty.v1.settings.import.apply.post({ ...base, select, allSafe, hashes })
      );
      json(result);
      printResult(result);
      return;
    }

    const preview = requireTreatyData<ImportSettingsPreview>(await client.treaty.v1.settings.import.preview.post(base));
    await maybeSavePreview(preview, flags);
    const visiblePreview = filteredPreview(preview, flags);
    json(visiblePreview);
    printPreview(visiblePreview);
  }
};
