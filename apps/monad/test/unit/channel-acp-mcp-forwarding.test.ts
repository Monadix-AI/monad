import type { McpServerConfig } from '@monad/home';
import type { SessionMcpServer } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { envRef } from '@monad/home';

import { channelDelegateMcpServers } from '#/handlers/session/handlers/messaging/index.ts';

const trust = { autoApproveTools: [], hostEscape: false };

test('channel ACP delegation forwards configured MCP servers with resolved env refs and session MCP servers', () => {
  const envKey = 'MONAD_CHANNEL_MCP_TOKEN';
  const previous = Bun.env[envKey];
  Bun.env[envKey] = 'resolved-token';
  try {
    const configured = [
      {
        name: 'configured',
        transport: 'stdio',
        command: 'cmd',
        args: ['--stdio'],
        env: { API_TOKEN: envRef('MONAD_CHANNEL_MCP_TOKEN') },
        enabled: true,
        trust
      }
    ] satisfies McpServerConfig[];
    const session = [
      {
        name: 'session-http',
        transport: 'http',
        url: 'https://mcp.example.test',
        headers: { authorization: 'Bearer session-token' }
      }
    ] satisfies SessionMcpServer[];

    const out = channelDelegateMcpServers(configured, session);

    expect(out.map((server) => server.name)).toEqual(['configured', 'session-http']);
    expect(out[0]).toMatchObject({ name: 'configured', command: 'cmd', args: ['--stdio'] });
    expect((out[0] as { env: { name: string; value: string }[] }).env).toEqual([
      { name: 'API_TOKEN', value: 'resolved-token' }
    ]);
    expect(out[1]).toMatchObject({ name: 'session-http', type: 'http', url: 'https://mcp.example.test' });
  } finally {
    if (previous === undefined) delete Bun.env[envKey];
    else Bun.env[envKey] = previous;
  }
});
