import type { McpRegistryAdapter, McpRegistryEntry } from '../adapter.ts';

import { createLogger } from '@monad/logger';
import { z } from 'zod';

const log = createLogger('marketplace');
const BASE = 'https://glama.ai/api/mcp/v1/servers';

const glamaResponseSchema = z.object({
  servers: z.array(
    z.object({
      id: z.string().optional(),
      name: z.string(),
      description: z.string().optional(),
      repository: z.object({ url: z.string().optional() }).optional(),
      environmentVariablesJsonSchema: z.object({ properties: z.record(z.string(), z.unknown()).optional() }).optional()
    })
  )
});

export class GlamaMcpAdapter implements McpRegistryAdapter {
  readonly id = 'glama';

  async search(query: string, opts?: { limit?: number }): Promise<McpRegistryEntry[]> {
    const limit = opts?.limit ?? 20;
    const url = `${BASE}?q=${encodeURIComponent(query)}&limit=${limit}`;
    let data: z.infer<typeof glamaResponseSchema>;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        log.warn(`glama registry returned ${res.status}`);
        return [];
      }
      data = glamaResponseSchema.parse(await res.json());
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
