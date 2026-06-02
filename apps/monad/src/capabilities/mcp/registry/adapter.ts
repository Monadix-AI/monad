import type { McpCatalogEntry } from '@monad/protocol';

export interface McpRegistryAdapter {
  id: string;
  search(query: string, opts?: { limit?: number }): Promise<McpRegistryEntry[]>;
}

export interface McpRegistryEntry {
  id: string;
  registry: string;
  name: string;
  description: string;
  homepage?: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  env: string[];
  verified?: boolean;
  stats?: { weeklyDownloads?: number; stars?: number };
}

export function toCatalogEntry(e: McpRegistryEntry): McpCatalogEntry {
  return {
    id: e.id,
    name: e.name,
    description: e.description,
    homepage: e.homepage,
    transport: e.transport,
    command: e.command,
    args: e.args,
    url: e.url,
    env: e.env
  };
}
