import { expect, test } from 'bun:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { createAgentFacingMcpHandler, createAgentFacingProtocolServer } from '../../src/lib/agent-facing-mcp-server.ts';

const toolNames = [
  'project_post',
  'project_ask',
  'project_read',
  'project_inbox_check',
  'project_inbox_ack',
  'agent_send',
  'agent_read',
  'session_members',
  'runtime_info',
  'project_plan_list',
  'project_plan_add',
  'project_plan_update',
  'project_plan_delete'
];

test('agent-facing MCP negotiates the latest protocol and executes a tool', async () => {
  const daemonResult = { runtime: 'managed', sessionId: 'ses_test' };
  const daemonClient = {
    treaty: {
      v1: {
        internal: {
          'native-agent': {
            runtime: {
              info: {
                get: async () => ({ data: daemonResult, status: 200 })
              }
            }
          }
        }
      }
    }
  };
  const handler = createAgentFacingMcpHandler(daemonClient as never);
  const client = new Client(
    { name: 'protocol-test', version: '0.0.0' },
    { capabilities: {}, versionNegotiation: { mode: 'auto' } }
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const serving = serveStdio(() => createAgentFacingProtocolServer(handler), { transport: serverTransport });

  try {
    await client.connect(clientTransport);

    expect({
      era: client.getProtocolEra(),
      protocolVersion: client.getNegotiatedProtocolVersion(),
      tools: (await client.listTools()).tools.map((tool) => tool.name)
    }).toEqual({
      era: 'modern',
      protocolVersion: '2026-07-28',
      tools: toolNames
    });
    expect(await client.callTool({ name: 'runtime_info', arguments: {} })).toEqual({
      _meta: {
        'io.modelcontextprotocol/serverInfo': {
          name: 'monad-native-agent',
          version: '0.0.0'
        }
      },
      content: [{ type: 'text', text: JSON.stringify(daemonResult, null, 2) }],
      isError: false
    });
  } finally {
    await client.close();
    await serving.close();
    await handler.close();
  }
});

test('agent-facing MCP still serves legacy initialize clients', async () => {
  const handler = createAgentFacingMcpHandler({} as never);
  const client = new Client(
    { name: 'legacy-test', version: '0.0.0' },
    { capabilities: {}, versionNegotiation: { mode: 'legacy' } }
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const serving = serveStdio(() => createAgentFacingProtocolServer(handler), {
    legacy: 'serve',
    transport: serverTransport
  });

  try {
    await client.connect(clientTransport);
    expect({
      era: client.getProtocolEra(),
      protocolVersion: client.getNegotiatedProtocolVersion(),
      toolNames: (await client.listTools()).tools.map((tool) => tool.name)
    }).toEqual({
      era: 'legacy',
      protocolVersion: '2025-11-25',
      toolNames
    });
  } finally {
    await client.close();
    await serving.close();
    await handler.close();
  }
});
