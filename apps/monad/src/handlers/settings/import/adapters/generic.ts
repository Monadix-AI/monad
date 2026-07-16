import type { KnownSource, ParsedImport, PlannedItem } from '../types.ts';

import { mcpEntries, mcpFromRecord } from './mcp.ts';
import { addItem, getPath, isRecord, pathInfo, readFirstConfigObject } from './shared.ts';

export async function parseGenericMcpConfig(inputPath: string, from: KnownSource): Promise<ParsedImport> {
  const { root, isDir } = await pathInfo(inputPath);
  const items: PlannedItem[] = [];
  const warnings: string[] = [];
  const cfg = await readFirstConfigObject(root, isDir, [
    ['settings.json'],
    ['mcp.json'],
    ['config.json'],
    ['config.yaml'],
    ['config.yml']
  ]);
  if (!cfg || !isRecord(cfg.data)) {
    warnings.push(`No ${from} settings/config file found at the provided path.`);
    return { from, path: root, items, warnings };
  }
  const mcpServers =
    getPath(cfg.data, ['mcpServers']) ??
    getPath(cfg.data, ['mcp', 'servers']) ??
    getPath(cfg.data, ['mcp_servers']) ??
    {};
  for (const [name, raw] of mcpEntries(mcpServers)) {
    const server = mcpFromRecord(name, raw);
    addItem(items, {
      category: 'mcpServers',
      source: `${cfg.path}:mcp.${name}`,
      target: name,
      action: server ? 'add' : 'manual',
      reason: server ? `${from} MCP server maps to Monad mcpServers` : `Unsupported ${from} MCP shape`,
      payload: server ? { kind: 'mcpServer', server } : { kind: 'manual' },
      risk: server?.transport === 'stdio' ? 'medium' : 'low',
      summary: server ? (server.transport === 'stdio' ? server.command : server.url) : undefined
    });
  }
  if (cfg.data.workflows || cfg.data.plugins || cfg.data.extensions || cfg.data.commands) {
    addItem(items, {
      category: 'plugins',
      source: cfg.path,
      target: `${from}:runtime`,
      action: 'manual',
      reason: `${from} workflow/plugin/runtime concepts are not Monad settings`,
      payload: { kind: 'manual' },
      risk: 'medium'
    });
  }
  return { from, path: root, items, warnings };
}
