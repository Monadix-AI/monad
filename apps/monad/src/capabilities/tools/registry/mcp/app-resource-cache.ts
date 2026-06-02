import type { Client, Tool as McpToolDefinition } from '@modelcontextprotocol/client';
import type { McpAppView } from '@monad/protocol';

import { createLogger } from '@monad/logger';

import { notifyMcpAppViewChanged } from './app-bridge.ts';
import { recordMcpAppRefresh } from './runtime-telemetry.ts';

const log = createLogger('mcp');
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_RESOURCES = 64;
const LOAD_CONCURRENCY = 4;

export interface McpAppResourceSnapshot {
  csp?: Record<string, unknown>;
  hash: string;
  html: string;
  permissions?: Record<string, unknown>;
}

export function mcpAppResourceUri(remote: McpToolDefinition): string | undefined {
  const ui = remote._meta?.ui;
  if (ui && typeof ui === 'object' && !Array.isArray(ui)) {
    const value = (ui as Record<string, unknown>).resourceUri;
    if (typeof value === 'string') return value;
  }
  const legacy = remote._meta?.['ui/resourceUri'];
  return typeof legacy === 'string' ? legacy : undefined;
}

export class McpAppResourceCache {
  private readonly resources = new Map<string, McpAppResourceSnapshot>();
  private readonly subscribed = new Set<string>();
  private generation = 0;

  constructor(
    private readonly client: Client,
    private readonly server: string,
    private readonly timeout: number,
    private readonly signal: AbortSignal,
    private readonly definitions: () => Iterable<McpToolDefinition>
  ) {}

  get(uri: string): McpAppResourceSnapshot | undefined {
    return this.resources.get(uri);
  }

  view(uri: string): McpAppView | undefined {
    const current = this.resources.get(uri);
    if (!current) return undefined;
    return {
      resourceUri: uri,
      html: current.html,
      revision: current.hash,
      ...(current.csp ? { csp: current.csp } : {}),
      ...(current.permissions ? { permissions: current.permissions } : {})
    };
  }

  readResource(uri: string, signal?: AbortSignal) {
    return this.client.readResource(
      { uri },
      { timeout: this.timeout, signal: signal ? AbortSignal.any([this.signal, signal]) : this.signal }
    );
  }

  async syncSubscriptions(tools: Iterable<McpToolDefinition>): Promise<void> {
    if (!this.client.getServerCapabilities()?.resources?.subscribe) return;
    const { truncated, uris } = resourceUris(tools);
    if (truncated) {
      log.warn({ limit: MAX_RESOURCES, server: this.server }, 'mcp app resource references exceeded the safe limit');
    }
    await mapConcurrent([...uris], LOAD_CONCURRENCY, async (uri) => {
      if (this.subscribed.has(uri)) return;
      try {
        await this.client.subscribeResource({ uri }, { timeout: this.timeout, signal: this.signal });
        this.subscribed.add(uri);
      } catch (error) {
        log.warn({ err: error, resourceUri: uri, server: this.server }, 'mcp app resource subscription failed');
      }
    });
  }

  async refresh(uri?: string): Promise<void> {
    const startedAt = performance.now();
    const { truncated, uris: referenced } = resourceUris(this.definitions());
    if (truncated) {
      log.warn({ limit: MAX_RESOURCES, server: this.server }, 'mcp app resource references exceeded the safe limit');
    }
    if (uri && !referenced.has(uri)) return;
    const targets = uri ? [uri] : [...referenced];
    const generation = ++this.generation;
    const loaded = await mapConcurrent(targets, LOAD_CONCURRENCY, async (resourceUri) => {
      try {
        return [resourceUri, await this.load(resourceUri)] as const;
      } catch (error) {
        log.warn({ err: error, resourceUri, server: this.server }, 'mcp app resource review failed');
        return [resourceUri, undefined] as const;
      }
    });
    if (generation !== this.generation) {
      recordMcpAppRefresh('stale', performance.now() - startedAt);
      return;
    }
    if (this.signal.aborted) {
      recordMcpAppRefresh('aborted', performance.now() - startedAt);
      return;
    }
    if (!uri) this.removeUnreferenced(referenced);
    for (const [resourceUri, snapshot] of loaded) {
      const previous = this.resources.get(resourceUri);
      if (snapshot) this.resources.set(resourceUri, snapshot);
      else this.resources.delete(resourceUri);
      if (previous && (!snapshot || previous.hash !== snapshot.hash)) {
        notifyMcpAppViewChanged(this.server, resourceUri);
        log.info({ resourceUri, server: this.server }, 'mcp app resource changed and views were refreshed');
      }
    }
    const failed = loaded.some(([, snapshot]) => snapshot === undefined);
    recordMcpAppRefresh(failed ? 'failed' : 'succeeded', performance.now() - startedAt);
    log.info(
      { durationMs: Math.round(performance.now() - startedAt), failed, resources: targets.length, server: this.server },
      'mcp app resource refresh completed'
    );
  }

  private async load(uri: string): Promise<McpAppResourceSnapshot> {
    const resource = await this.readResource(uri);
    const content = resource.contents.find(
      (item): item is typeof item & { text: string } => 'text' in item && typeof item.text === 'string'
    );
    if (!content || Buffer.byteLength(content.text) > MAX_HTML_BYTES) {
      throw new Error(`MCP App resource "${uri}" is missing text HTML or exceeds ${MAX_HTML_BYTES} bytes`);
    }
    const ui =
      content._meta?.ui && typeof content._meta.ui === 'object' && !Array.isArray(content._meta.ui)
        ? (content._meta.ui as Record<string, unknown>)
        : undefined;
    const csp = ui?.csp;
    const permissions = ui?.permissions;
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(JSON.stringify({ html: content.text, csp, permissions }));
    return {
      html: content.text,
      hash: hasher.digest('hex'),
      ...(csp && typeof csp === 'object' && !Array.isArray(csp) ? { csp: csp as Record<string, unknown> } : {}),
      ...(permissions && typeof permissions === 'object' && !Array.isArray(permissions)
        ? { permissions: permissions as Record<string, unknown> }
        : {})
    };
  }

  private removeUnreferenced(referenced: Set<string>): void {
    for (const uri of this.resources.keys()) {
      if (!referenced.has(uri)) {
        this.resources.delete(uri);
        notifyMcpAppViewChanged(this.server, uri);
      }
    }
    for (const uri of this.subscribed) {
      if (referenced.has(uri)) continue;
      this.subscribed.delete(uri);
      void this.client.unsubscribeResource({ uri }, { timeout: this.timeout, signal: this.signal }).catch(() => {});
    }
  }
}

function resourceUris(tools: Iterable<McpToolDefinition>): { truncated: boolean; uris: Set<string> } {
  const uris = new Set<string>();
  let truncated = false;
  for (const tool of tools) {
    const uri = mcpAppResourceUri(tool);
    if (!uri || uris.has(uri)) continue;
    if (uris.size >= MAX_RESOURCES) {
      truncated = true;
      break;
    }
    uris.add(uri);
  }
  return { truncated, uris };
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= values.length) return;
        results[index] = await map(values[index] as T);
      }
    })
  );
  return results;
}
