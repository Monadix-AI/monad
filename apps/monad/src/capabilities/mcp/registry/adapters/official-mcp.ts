import type { McpRegistryAdapter, McpRegistryEntry } from '../adapter.ts';

import { createLogger } from '@monad/logger';
import { z } from 'zod';

const log = createLogger('marketplace');
const BASE = 'https://registry.modelcontextprotocol.io/v0/servers';

const officialResponseSchema = z.object({
  servers: z.array(
    z.object({
      server: z.object({
        name: z.string(),
        description: z.string().optional(),
        packages: z
          .array(
            z.object({
              registryType: z.string(),
              identifier: z.string(),
              version: z.string().optional(),
              runtimeHint: z.string().optional(),
              environmentVariables: z
                .array(z.object({ name: z.string(), isRequired: z.boolean().optional() }))
                .optional()
            })
          )
          .optional()
      })
    })
  )
});

export class OfficialMcpAdapter implements McpRegistryAdapter {
  readonly id = 'official-mcp';

  async search(query: string, opts?: { limit?: number }): Promise<McpRegistryEntry[]> {
    const limit = opts?.limit ?? 20;
    const url = `${BASE}?search=${encodeURIComponent(query)}&limit=${limit}`;
    let data: z.infer<typeof officialResponseSchema>;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        log.warn(`official-mcp registry returned ${res.status}`);
        return [];
      }
      data = officialResponseSchema.parse(await res.json());
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
