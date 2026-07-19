import type { AdapterMigrationItem, ImportSettingsRequest } from '@monad/protocol';
import type { ParsedImport, PlannedItem } from '../types.ts';

import { importSettingsSourceSchema } from '@monad/protocol';

import { findMeshAgentProviderAdapter, listMeshAgentProviderAdapters } from '#/services/mesh-agent/index.ts';
import { detectSource } from './detect.ts';
import { parseGenericMcpConfig } from './generic.ts';

function adapterItem(item: AdapterMigrationItem): PlannedItem | null {
  if (item.category === 'meshAgents') return null;
  const payload = item.payload;
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    !('kind' in payload) ||
    typeof payload.kind !== 'string'
  ) {
    return {
      id: item.id,
      category: item.category,
      source: item.source,
      target: item.target,
      action: 'manual',
      reason: item.reason,
      risk: item.risk,
      summary: item.summary,
      payload: { kind: 'manual' }
    };
  }
  return {
    id: item.id,
    category: item.category,
    source: item.source,
    target: item.target,
    action: item.action,
    reason: item.reason,
    risk: item.risk,
    summary: item.summary,
    payload: payload as PlannedItem['payload']
  };
}

async function parseAdapterSource(req: ImportSettingsRequest): Promise<ParsedImport | null> {
  if (req.from === 'auto') return null;
  const migration = findMeshAgentProviderAdapter(req.from)?.settingsImport;
  if (!migration) return null;
  const preview = await migration.preview({ path: req.path, replace: req.replace });
  return {
    from: req.from,
    path: preview.path,
    items: preview.items.flatMap((item) => {
      const planned = adapterItem(item);
      return planned ? [planned] : [];
    }),
    warnings: preview.warnings
  };
}

async function detectAdapterSource(req: ImportSettingsRequest): Promise<ParsedImport | null> {
  for (const adapter of listMeshAgentProviderAdapters()) {
    const migration = adapter.settingsImport;
    if (!migration?.recognizes || !(await migration.recognizes(req.path))) continue;
    const from = importSettingsSourceSchema.exclude(['auto']).safeParse(adapter.provider);
    if (!from.success) continue;
    return parseAdapterSource({ ...req, from: from.data });
  }
  return null;
}

export async function parseSource(req: ImportSettingsRequest): Promise<ParsedImport> {
  const adapterParsed = await parseAdapterSource(req);
  if (adapterParsed) return adapterParsed;
  if (req.from === 'auto') {
    const detectedAdapter = await detectAdapterSource(req);
    if (detectedAdapter) return detectedAdapter;
  }
  const from = req.from === 'auto' ? await detectSource(req.path) : req.from;
  switch (from) {
    case 'cursor':
    case 'claude-desktop':
    case 'vscode':
    case 'aider':
    case 'continue':
    case 'roo-code':
      return parseGenericMcpConfig(req.path, from);
    default:
      throw new Error(`no registered settings import adapter for source "${from}"`);
  }
}
