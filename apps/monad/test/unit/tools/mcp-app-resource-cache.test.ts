import type { Client, Tool } from '@modelcontextprotocol/client';

import { expect, test } from 'bun:test';

import {
  invokeMcpAppBridge,
  issueMcpAppCapability,
  registerMcpAppBridge,
  revokeMcpAppBridgesForServer
} from '#/capabilities/tools/registry/mcp/app-bridge.ts';
import { McpAppResourceCache } from '#/capabilities/tools/registry/mcp/app-resource-cache.ts';

function tool(uri: string): Tool {
  return { name: uri, inputSchema: { type: 'object' }, _meta: { ui: { resourceUri: uri } } };
}

test('MCP App resource refresh bounds concurrency and retained resources', async () => {
  let active = 0;
  let maxActive = 0;
  const reads: string[] = [];
  const client = {
    readResource: async ({ uri }: { uri: string }) => {
      reads.push(uri);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Bun.sleep(1);
      active -= 1;
      return { contents: [{ uri, text: `<main>${uri}</main>` }] };
    }
  } as unknown as Client;
  const definitions = Array.from({ length: 80 }, (_, index) => tool(`ui://bounded/${index}`));
  const cache = new McpAppResourceCache(client, 'bounded', 1_000, new AbortController().signal, () => definitions);

  await cache.refresh();

  expect({ maxActive, reads: reads.length, lastRetained: cache.view('ui://bounded/63')?.resourceUri }).toEqual({
    maxActive: 4,
    reads: 64,
    lastRetained: 'ui://bounded/63'
  });
});

test('MCP App resource refresh ignores stale generations', async () => {
  let releaseFirst: (() => void) | undefined;
  let reads = 0;
  const client = {
    readResource: async ({ uri }: { uri: string }) => {
      const currentRead = ++reads;
      if (currentRead === 1) await new Promise<void>((resolve) => (releaseFirst = resolve));
      return { contents: [{ uri, text: `<main>${currentRead === 1 ? 'old' : 'new'}</main>` }] };
    }
  } as unknown as Client;
  const cache = new McpAppResourceCache(client, 'generation', 1_000, new AbortController().signal, () => [
    tool('ui://generation/app')
  ]);

  const first = cache.refresh();
  await Bun.sleep(0);
  const second = cache.refresh();
  await second;
  releaseFirst?.();
  await first;

  expect(cache.view('ui://generation/app')?.html).toBe('<main>new</main>');
});

test('MCP App resource deletion revokes views and removes subscriptions', async () => {
  let definitions = [tool('ui://deletion/app')];
  const unsubscribed: string[] = [];
  const client = {
    getServerCapabilities: () => ({ resources: { subscribe: true } }),
    readResource: async ({ uri }: { uri: string }) => ({ contents: [{ uri, text: '<main />' }] }),
    subscribeResource: async () => ({}),
    unsubscribeResource: async ({ uri }: { uri: string }) => {
      unsubscribed.push(uri);
      return {};
    }
  } as unknown as Client;
  const cache = new McpAppResourceCache(client, 'deletion', 1_000, new AbortController().signal, () => definitions);
  await cache.syncSubscriptions(definitions);
  await cache.refresh();
  const bridgeId = registerMcpAppBridge({
    server: 'deletion',
    sessionId: 'ses_deletion',
    resourceUri: 'ui://deletion/app',
    callTool: async () => ({}),
    readResource: (uri, signal) => cache.readResource(uri, signal),
    readView: () => cache.view('ui://deletion/app')
  });
  const { token } = issueMcpAppCapability(bridgeId, 'ses_deletion');

  definitions = [];
  await cache.refresh();
  await Bun.sleep(0);
  const invocation = await invokeMcpAppBridge(token, {
    method: 'resources/read',
    params: { uri: 'ui://deletion/app' }
  }).catch((error) => error);

  expect({
    hasView: cache.view('ui://deletion/app') !== undefined,
    invocation: invocation instanceof Error ? invocation.message : invocation,
    unsubscribed
  }).toEqual({
    hasView: false,
    invocation: 'MCP App capability is invalid',
    unsubscribed: ['ui://deletion/app']
  });
  revokeMcpAppBridgesForServer('deletion');
});
