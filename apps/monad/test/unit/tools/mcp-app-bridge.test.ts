import { expect, test } from 'bun:test';

import {
  invokeMcpAppBridge,
  issueMcpAppCapability,
  McpAppBridgeError,
  mcpAppBridgeMetrics,
  notifyMcpAppViewChanged,
  registerMcpAppBridge,
  revokeMcpAppBridgesForServer,
  revokeMcpAppCapability,
  waitForMcpAppView
} from '#/capabilities/tools/registry/mcp/app-bridge.ts';

test('MCP App capability invokes its bound tool and exact resource', async () => {
  const calls: unknown[] = [];
  const bridgeId = registerMcpAppBridge({
    server: 'bridge-test',
    sessionId: 'ses_bridge_test',
    resourceUri: 'ui://bridge/app',
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { content: [{ type: 'text', text: 'done' }] };
    },
    readResource: async (uri) => ({ contents: [{ uri, text: '<main />' }] }),
    readView: () => ({ resourceUri: 'ui://bridge/app', html: '<main />', revision: 'one' })
  });
  const { token } = issueMcpAppCapability(bridgeId, 'ses_bridge_test');

  const tool = await invokeMcpAppBridge(token, {
    method: 'tools/call',
    params: { name: 'refresh', arguments: { page: 2 } }
  });
  const resource = await invokeMcpAppBridge(token, {
    method: 'resources/read',
    params: { uri: 'ui://bridge/app' }
  });

  expect({ calls, tool, resource }).toEqual({
    calls: [{ name: 'refresh', args: { page: 2 } }],
    tool: { content: [{ type: 'text', text: 'done' }] },
    resource: { contents: [{ uri: 'ui://bridge/app', text: '<main />' }] }
  });
  revokeMcpAppBridgesForServer('bridge-test');
});

test('MCP App view updates wake existing bridges and revoke stale capabilities', async () => {
  let revision = 'one';
  const bridgeId = registerMcpAppBridge({
    server: 'bridge-live',
    sessionId: 'ses_live',
    resourceUri: 'ui://bridge/live',
    callTool: async () => ({}),
    readResource: async () => ({}),
    readView: () => ({ resourceUri: 'ui://bridge/live', html: `<main>${revision}</main>`, revision })
  });
  const { token } = issueMcpAppCapability(bridgeId, 'ses_live');
  const update = waitForMcpAppView(bridgeId, 'ses_live', 'one');
  revision = 'two';
  notifyMcpAppViewChanged('bridge-live', 'ui://bridge/live');

  const [view, staleCapability] = await Promise.all([
    update,
    invokeMcpAppBridge(token, { method: 'resources/read', params: { uri: 'ui://bridge/live' } }).catch((error) => error)
  ]);

  expect({
    view,
    staleCapability:
      staleCapability instanceof McpAppBridgeError
        ? { message: staleCapability.message, status: staleCapability.status }
        : staleCapability
  }).toEqual({
    view: {
      changed: true,
      view: { resourceUri: 'ui://bridge/live', html: '<main>two</main>', revision: 'two' }
    },
    staleCapability: { message: 'MCP App capability is invalid', status: 404 }
  });
  revokeMcpAppBridgesForServer('bridge-live');
});

test('MCP App bridge issues only session-bound capabilities and supports explicit teardown', async () => {
  const bridgeId = registerMcpAppBridge({
    server: 'bridge-session',
    sessionId: 'ses_owner',
    resourceUri: 'ui://bridge/app',
    callTool: async () => ({}),
    readResource: async () => ({}),
    readView: () => ({ resourceUri: 'ui://bridge/app', html: '<main />', revision: 'one' })
  });
  const denied = (() => {
    try {
      issueMcpAppCapability(bridgeId, 'ses_other');
    } catch (error) {
      return error;
    }
  })();
  const { token } = issueMcpAppCapability(bridgeId, 'ses_owner');
  const revoked = revokeMcpAppCapability(token);
  const afterTeardown = await invokeMcpAppBridge(token, {
    method: 'resources/read',
    params: { uri: 'ui://bridge/app' }
  }).catch((error) => error);

  expect({
    denied: denied instanceof McpAppBridgeError ? { message: denied.message, status: denied.status } : denied,
    revoked,
    afterTeardown:
      afterTeardown instanceof McpAppBridgeError
        ? { message: afterTeardown.message, status: afterTeardown.status }
        : afterTeardown
  }).toEqual({
    denied: { message: 'MCP App bridge belongs to another session', status: 403 },
    revoked: true,
    afterTeardown: { message: 'MCP App capability is invalid', status: 404 }
  });
  revokeMcpAppBridgesForServer('bridge-session');
});

test('MCP App capability issuance rejects a stale rendered revision', () => {
  const bridgeId = registerMcpAppBridge({
    server: 'bridge-revision',
    sessionId: 'ses_revision',
    resourceUri: 'ui://bridge/revision',
    callTool: async () => ({}),
    readResource: async () => ({}),
    readView: () => ({ resourceUri: 'ui://bridge/revision', html: '<main />', revision: 'current' })
  });
  const result = (() => {
    try {
      return issueMcpAppCapability(bridgeId, 'ses_revision', 'stale');
    } catch (error) {
      return error;
    }
  })();

  expect(result instanceof McpAppBridgeError ? { message: result.message, status: result.status } : result).toEqual({
    message: 'MCP App view revision is stale',
    status: 410
  });
  revokeMcpAppBridgesForServer('bridge-revision');
});

test('MCP App invocation propagates host request cancellation', async () => {
  const bridgeId = registerMcpAppBridge({
    server: 'bridge-abort',
    sessionId: 'ses_abort',
    resourceUri: 'ui://bridge/app',
    callTool: async () => ({}),
    readResource: (_uri, signal) =>
      new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    readView: () => ({ resourceUri: 'ui://bridge/app', html: '<main />', revision: 'one' })
  });
  const { token } = issueMcpAppCapability(bridgeId, 'ses_abort');
  const controller = new AbortController();
  const result = invokeMcpAppBridge(
    token,
    { method: 'resources/read', params: { uri: 'ui://bridge/app' } },
    controller.signal
  ).catch((error) => error);
  controller.abort(new Error('frame closed'));

  expect(await result).toEqual(new Error('frame closed'));
  revokeMcpAppBridgesForServer('bridge-abort');
});

test('MCP App capability rejects cross-resource reads and is revoked with its server', async () => {
  const bridgeId = registerMcpAppBridge({
    server: 'bridge-revoke',
    sessionId: 'ses_bridge_revoke',
    resourceUri: 'ui://bridge/app',
    callTool: async () => ({}),
    readResource: async () => ({}),
    readView: () => ({ resourceUri: 'ui://bridge/app', html: '<main />', revision: 'one' })
  });
  const { token } = issueMcpAppCapability(bridgeId, 'ses_bridge_revoke');

  const denied = await invokeMcpAppBridge(token, {
    method: 'resources/read',
    params: { uri: 'ui://other/app' }
  }).catch((error) => error);
  revokeMcpAppBridgesForServer('bridge-revoke');
  const revoked = await invokeMcpAppBridge(token, {
    method: 'resources/read',
    params: { uri: 'ui://bridge/app' }
  }).catch((error) => error);

  expect({
    denied: denied instanceof McpAppBridgeError ? { message: denied.message, status: denied.status } : denied,
    revoked: revoked instanceof McpAppBridgeError ? { message: revoked.message, status: revoked.status } : revoked
  }).toEqual({
    denied: { message: 'MCP App resource is outside this capability', status: 403 },
    revoked: { message: 'MCP App capability is invalid', status: 404 }
  });
});

test('MCP App view waits enforce a per-bridge concurrency limit', async () => {
  const bridgeId = registerMcpAppBridge({
    server: 'bridge-waiters',
    sessionId: 'ses_waiters',
    resourceUri: 'ui://bridge/waiters',
    callTool: async () => ({}),
    readResource: async () => ({}),
    readView: () => ({ resourceUri: 'ui://bridge/waiters', html: '<main />', revision: 'one' })
  });
  const controllers = Array.from({ length: 8 }, () => new AbortController());
  const accepted = controllers.map((controller) =>
    waitForMcpAppView(bridgeId, 'ses_waiters', 'one', controller.signal)
  );
  const activeViewWaiters = mcpAppBridgeMetrics().activeViewWaiters;
  const rejected = await waitForMcpAppView(bridgeId, 'ses_waiters', 'one').catch((error) => error);
  for (const controller of controllers) controller.abort();
  await Promise.all(accepted);

  expect({
    activeViewWaiters,
    rejected: rejected instanceof McpAppBridgeError ? { message: rejected.message, status: rejected.status } : rejected,
    remainingViewWaiters: mcpAppBridgeMetrics().activeViewWaiters
  }).toEqual({
    activeViewWaiters: 8,
    rejected: { message: 'MCP App view waiter limit exceeded', status: 429 },
    remainingViewWaiters: 0
  });
  revokeMcpAppBridgesForServer('bridge-waiters');
});
