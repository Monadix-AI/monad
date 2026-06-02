import type { McpRegistryAdapter, McpRegistryEntry } from '../adapter.ts';

import { createLogger } from '@monad/logger';

const log = createLogger('marketplace');
const BASE = 'https://registry.smithery.ai/servers';

interface SmitheryConnection {
  type: string;
  deploymentUrl?: string;
  configSchema?: unknown;
}

interface SmitheryServer {
  qualifiedName: string;
  displayName?: string;
  description?: string;
  iconUrl?: string;
  verified?: boolean;
  useCount?: number;
  remote?: boolean;
  homepage?: string;
  connections?: SmitheryConnection[];
}

interface SmitheryResponse {
  servers: SmitheryServer[];
}

export class SmitheryMcpAdapter implements McpRegistryAdapter {
  readonly id = 'smithery';

  async search(query: string, opts?: { limit?: number }): Promise<McpRegistryEntry[]> {
    const pageSize = opts?.limit ?? 20;
    const url = `${BASE}?q=${encodeURIComponent(query)}&pageSize=${pageSize}`;
    let data: SmitheryResponse;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        log.warn(`smithery registry returned ${res.status}`);
        return [];
      }
      data = (await res.json()) as SmitheryResponse;
    } catch (err) {
      log.warn({ err }, 'smithery registry fetch failed');
      return [];
    }

    const entries: McpRegistryEntry[] = [];
    for (const s of data.servers) {
      const httpConn = s.connections?.find((c) => c.type === 'http' && c.deploymentUrl);
      if (httpConn?.deploymentUrl) {
        entries.push({
          id: `smithery:${s.qualifiedName}`,
          registry: this.id,
          name: s.displayName ?? s.qualifiedName,
          description: s.description ?? '',
          homepage: s.homepage,
          transport: 'http',
          url: httpConn.deploymentUrl,
          env: [],
          verified: s.verified,
          stats: { weeklyDownloads: s.useCount }
        });
      } else if (!s.connections?.length) {
        entries.push({
          id: `smithery:${s.qualifiedName}`,
          registry: this.id,
          name: s.displayName ?? s.qualifiedName,
          description: s.description ?? '',
          homepage: s.homepage,
          transport: 'stdio',
          env: [],
          verified: s.verified,
          stats: { weeklyDownloads: s.useCount }
        });
      }
    }
    return entries;
  }
}
