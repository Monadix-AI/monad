import type { McpRegistryAdapter, McpRegistryEntry } from '../adapter.ts';

import { createLogger } from '@monad/logger';

const log = createLogger('marketplace');
const BASE = 'https://registry.modelcontextprotocol.io/v0/servers';

interface OfficialServer {
  server: {
    name: string;
    description?: string;
    packages?: Array<{
      registryType: string;
      identifier: string;
      version?: string;
      runtimeHint?: string;
      environmentVariables?: Array<{ name: string; isRequired?: boolean }>;
    }>;
  };
}

interface OfficialResponse {
  servers: OfficialServer[];
}

export class OfficialMcpAdapter implements McpRegistryAdapter {
  readonly id = 'official-mcp';

  async search(query: string, opts?: { limit?: number }): Promise<McpRegistryEntry[]> {
    const limit = opts?.limit ?? 20;
    const url = `${BASE}?search=${encodeURIComponent(query)}&limit=${limit}`;
    let data: OfficialResponse;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        log.warn(`official-mcp registry returned ${res.status}`);
        return [];
      }
      data = (await res.json()) as OfficialResponse;
    } catch (err) {
      log.warn({ err }, 'official-mcp registry fetch failed');
      return [];
    }

    const entries: McpRegistryEntry[] = [];
    for (const { server } of data.servers) {
      const npm = server.packages?.find((p) => p.registryType === 'npm');
      if (!npm) continue;

      const version = npm.version ? `${npm.identifier}@${npm.version}` : npm.identifier;
      const env = (npm.environmentVariables ?? []).filter((v) => v.isRequired !== false).map((v) => v.name);

      entries.push({
        id: `official-mcp:${npm.identifier}`,
        registry: this.id,
        name: server.name,
        description: server.description ?? '',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', version],
        env
      });
    }
    return entries;
  }
}
