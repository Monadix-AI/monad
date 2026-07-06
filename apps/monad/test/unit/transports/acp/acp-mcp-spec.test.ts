import type { McpServer } from '@agentclientprotocol/sdk';

import { expect, test } from 'bun:test';

import { toMcpSpec } from '@/transports/acp/connection.ts';

test('toMcpSpec maps a stdio MCP server (env array → record)', () => {
  const server = {
    name: 'fs',
    command: 'mcp-fs',
    args: ['--root', '/p'],
    env: [{ name: 'TOKEN', value: 'x' }]
  } as unknown as McpServer;
  expect(toMcpSpec(server)).toEqual({
    name: 'fs',
    command: 'mcp-fs',
    args: ['--root', '/p'],
    env: { TOKEN: 'x' }
  });
});

test('toMcpSpec maps an http MCP server (headers array → record)', () => {
  const server = {
    type: 'http',
    name: 'remote',
    url: 'https://mcp.example/sse',
    headers: [{ name: 'Authorization', value: 'Bearer t' }]
  } as unknown as McpServer;
  expect(toMcpSpec(server)).toEqual({
    name: 'remote',
    transport: 'http',
    url: 'https://mcp.example/sse',
    headers: { Authorization: 'Bearer t' }
  });
});

test('toMcpSpec returns null for transports monad cannot speak (sse, acp)', () => {
});
