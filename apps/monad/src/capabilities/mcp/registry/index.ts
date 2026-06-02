import type { McpRegistryAdapter, McpRegistryEntry } from './adapter.ts';

interface CacheEntry {
  data: McpRegistryEntry[];
  expiresAt: number;
}

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

export async function searchMcpRegistry(
  query: string,
  adapters: McpRegistryAdapter[],
  opts?: { limit?: number }
): Promise<McpRegistryEntry[]> {
  const results = await Promise.all(adapters.map((adapter) => searchOne(adapter, query, opts)));

  const seen = new Map<string, McpRegistryEntry>();
  for (const entries of results) {
    for (const entry of entries) {
      const key = entry.homepage ?? entry.id;
      if (!seen.has(key)) seen.set(key, entry);
    }
  }

  const limit = opts?.limit ?? 20;
  return [...seen.values()].slice(0, limit);
}

async function searchOne(
  adapter: McpRegistryAdapter,
  query: string,
  opts?: { limit?: number }
): Promise<McpRegistryEntry[]> {
  const key = `${adapter.id}:${query}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const data = await adapter.search(query, opts);
  cache.set(key, { data, expiresAt: Date.now() + TTL_MS });
  return data;
}
