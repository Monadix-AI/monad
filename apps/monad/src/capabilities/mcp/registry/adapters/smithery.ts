import type { McpRegistryAdapter, McpRegistryEntry } from '../adapter.ts';

import { createLogger } from '@monad/logger';
import { z } from 'zod';

const log = createLogger('marketplace');
const BASE = 'https://registry.smithery.ai/servers';

const smitheryResponseSchema = z.object({
  servers: z.array(
    z.object({
      qualifiedName: z.string(),
      displayName: z.string().optional(),
      description: z.string().optional(),
      iconUrl: z.string().optional(),
      verified: z.boolean().optional(),
      useCount: z.number().optional(),
      remote: z.boolean().optional(),
      homepage: z.string().optional(),
      connections: z
        .array(
          z.object({ type: z.string(), deploymentUrl: z.string().optional(), configSchema: z.unknown().optional() })
        )
        .optional()
    })
  )
});

export class SmitheryMcpAdapter implements McpRegistryAdapter {
  readonly id = 'smithery';

  async search(query: string, opts?: { limit?: number }): Promise<McpRegistryEntry[]> {
    const pageSize = opts?.limit ?? 20;
    const url = `${BASE}?q=${encodeURIComponent(query)}&pageSize=${pageSize}`;
    let data: z.infer<typeof smitheryResponseSchema>;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        log.warn(`smithery registry returned ${res.status}`);
        return [];
      }
      data = smitheryResponseSchema.parse(await res.json());
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
