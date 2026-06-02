import type { McpRegistryAdapter, McpRegistryEntry } from '../adapter.ts';

import { createLogger } from '@monad/logger';

const log = createLogger('marketplace');
const BASE = 'https://glama.ai/api/mcp/v1/servers';

interface GlamaServer {
  id?: string;
  name: string;
  description?: string;
  repository?: { url?: string };
  environmentVariablesJsonSchema?: { properties?: Record<string, unknown> };
}

interface GlamaResponse {
  servers: GlamaServer[];
}

export class GlamaMcpAdapter implements McpRegistryAdapter {
  readonly id = 'glama';

  async search(query: string, opts?: { limit?: number }): Promise<McpRegistryEntry[]> {
    const limit = opts?.limit ?? 20;
    const url = `${BASE}?q=${encodeURIComponent(query)}&limit=${limit}`;
    let data: GlamaResponse;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        log.warn(`glama registry returned ${res.status}`);
        return [];
      }
      data = (await res.json()) as GlamaResponse;
    } catch (err) {
      log.warn({ err }, 'glama registry fetch failed');
      return [];
    }

    return data.servers.map((s) => {
      const slug = s.id ?? s.name.toLowerCase().replace(/\s+/g, '-');
      const env = Object.keys(s.environmentVariablesJsonSchema?.properties ?? {});
      return {
        id: `glama:${slug}`,
        registry: this.id,
        name: s.name,
        description: s.description ?? '',
        homepage: `https://glama.ai/mcp/servers/${slug}`,
        transport: 'stdio' as const,
        env
      };
    });
  }
}
