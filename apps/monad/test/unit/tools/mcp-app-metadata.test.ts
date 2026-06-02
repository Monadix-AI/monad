import { expect, test } from 'bun:test';

import {
  assertMcpToolVisibleToApp,
  McpUrlCompletionRegistry,
  mcpAppResourceUri,
  mcpToolVisibleToApp,
  mcpToolVisibleToModel
} from '#/capabilities/tools/registry/mcp';
import { McpAppBridgeError } from '#/capabilities/tools/registry/mcp/app-bridge';

test('MCP App metadata prefers the current nested resource URI and accepts the legacy key', () => {
  expect({
    current: mcpAppResourceUri({
      name: 'current',
      inputSchema: { type: 'object' },
      _meta: { ui: { resourceUri: 'ui://current' }, 'ui/resourceUri': 'ui://legacy' }
    }),
    legacy: mcpAppResourceUri({
      name: 'legacy',
      inputSchema: { type: 'object' },
      _meta: { 'ui/resourceUri': 'ui://legacy' }
    })
  }).toEqual({ current: 'ui://current', legacy: 'ui://legacy' });
});

test('MCP App app-only tools stay out of the model tool registry', () => {
  expect({
    appOnly: mcpToolVisibleToModel({
      name: 'refresh',
      inputSchema: { type: 'object' },
      _meta: { ui: { visibility: ['app'] } }
    }),
    model: mcpToolVisibleToModel({
      name: 'query',
      inputSchema: { type: 'object' },
      _meta: { ui: { visibility: ['model', 'app'] } }
    }),
    defaultVisibility: mcpToolVisibleToModel({ name: 'plain', inputSchema: { type: 'object' } })
  }).toEqual({ appOnly: false, model: true, defaultVisibility: true });
});

test('MCP App rejects model-only tools while preserving default and app visibility', () => {
  let rejected: unknown;
  try {
    assertMcpToolVisibleToApp({
      name: 'private',
      inputSchema: { type: 'object' },
      _meta: { ui: { visibility: ['model'] } }
    });
  } catch (error) {
    rejected = error;
  }
  expect({
    modelOnly: mcpToolVisibleToApp({
      name: 'private',
      inputSchema: { type: 'object' },
      _meta: { ui: { visibility: ['model'] } }
    }),
    app: mcpToolVisibleToApp({ name: 'app', inputSchema: { type: 'object' }, _meta: { ui: { visibility: ['app'] } } }),
    defaultVisibility: mcpToolVisibleToApp({ name: 'plain', inputSchema: { type: 'object' } }),
    rejected: rejected instanceof McpAppBridgeError ? { message: rejected.message, status: rejected.status } : rejected
  }).toEqual({
    modelOnly: false,
    app: true,
    defaultVisibility: true,
    rejected: { message: 'MCP App tool is not visible to apps: private', status: 403 }
  });
});

test('URL elicitation completion settles pending ids and ignores unknown ids', async () => {
  const registry = new McpUrlCompletionRegistry();
  const completed: string[] = [];
  await registry.complete('unknown');
  registry.register('pending', async () => {
    completed.push('pending');
  });
  await registry.complete('pending');
  await registry.complete('pending');
  expect(completed).toEqual(['pending']);
});
