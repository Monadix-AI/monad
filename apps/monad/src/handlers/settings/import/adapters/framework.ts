import type { ParsedImport, PlannedItem } from '../types.ts';

import { join } from 'node:path';

import { mcpEntries, mcpFromRecord } from './mcp.ts';
import { addModelProfileFromExternal, providerFromRecord } from './providers.ts';
import { addItem, asString, getPath, isRecord, pathInfo, readFirstConfigObject } from './shared.ts';
import { addSkillItems } from './skill-items.ts';

function configNamesForFramework(from: 'hermes' | 'openclaw'): string[][] {
  return from === 'hermes'
    ? [['config.yaml'], ['config.yml'], ['config.json'], ['hermes.yaml'], ['hermes.json']]
    : [['openclaw.json'], ['config.json'], ['config.yaml'], ['config.yml'], ['openclaw.yaml'], ['openclaw.yml']];
}

export async function parseFramework(inputPath: string, from: 'hermes' | 'openclaw'): Promise<ParsedImport> {
  const { root, isDir } = await pathInfo(inputPath);
  const items: PlannedItem[] = [];
  const warnings: string[] = [];
  const cfg = await readFirstConfigObject(root, isDir, configNamesForFramework(from));
  if (!cfg || !isRecord(cfg.data)) {
    warnings.push(`No ${from} config file found at the provided path.`);
  } else {
    const mcpServers =
      getPath(cfg.data, ['mcp_servers']) ??
      getPath(cfg.data, ['mcpServers']) ??
      getPath(cfg.data, ['mcp', 'servers']) ??
      {};
    for (const [name, raw] of mcpEntries(mcpServers)) {
      const server = mcpFromRecord(name, raw);
      addItem(items, {
        category: 'mcpServers',
        source: `${cfg.path}:mcp.${name}`,
        target: name,
        action: server ? 'add' : 'manual',
        reason: server ? `${from} MCP server maps to monad mcpServers` : `Unsupported ${from} MCP shape`,
        payload: server ? { kind: 'mcpServer', server } : { kind: 'manual' },
        risk: server?.transport === 'stdio' ? 'medium' : 'low'
      });
    }
    const providers = isRecord(cfg.data.providers)
      ? cfg.data.providers
      : isRecord(cfg.data.models)
        ? cfg.data.models
        : {};
    for (const [name, raw] of Object.entries(providers)) {
      const provider = providerFromRecord(name, raw);
      if (provider) {
        addItem(items, {
          category: 'modelProviders',
          source: `${cfg.path}:providers.${name}`,
          target: provider.id,
          action: 'add',
          reason: `${from} provider has a direct monad provider type`,
          payload: { kind: 'modelProvider', provider }
        });
      }
    }
    const model =
      asString(getPath(cfg.data, ['model', 'default'])) ?? asString(cfg.data.default_model) ?? asString(cfg.data.model);
    const providerId =
      asString(getPath(cfg.data, ['model', 'provider'])) ??
      (model?.includes('/') ? model.split('/')[0] : undefined) ??
      asString(cfg.data.provider);
    if (model) addModelProfileFromExternal(items, `${cfg.path}:model`, from, model, providerId);
    if (
      cfg.data.workflow ||
      cfg.data.workflows ||
      cfg.data.state ||
      cfg.data.database ||
      cfg.data.runtime_plugins ||
      cfg.data.plugins
    ) {
      addItem(items, {
        category: 'plugins',
        source: cfg.path,
        target: `${from}:runtime`,
        action: 'manual',
        reason: `${from} workflow/state/runtime plugin concepts are not monad settings`,
        payload: { kind: 'manual' },
        risk: 'medium'
      });
    }
  }
  if (isDir) await addSkillItems(items, `${from}:skills`, join(root, 'skills'));
  return { from, path: root, items, warnings };
}
