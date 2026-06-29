import { expect, test } from 'bun:test';

import { mcpRegistryEntrySchema, skillDetailSchema } from '../src/marketplace.ts';
import { mcpServerViewSchema } from '../src/mcp-server.ts';
import { peerViewSchema } from '../src/peer.ts';

test('MCP HTTP server URLs accept local HTTP but reject non-HTTP schemes', () => {
  const parsed = mcpServerViewSchema.parse({
    name: 'local',
    transport: 'http',
    url: '  http://127.0.0.1:8787/mcp  ',
    auth: { mode: 'none' },
    enabled: true,
    trust: { autoApproveTools: [] }
  });
  expect(parsed.transport).toBe('http');
  if (parsed.transport !== 'http') throw new Error('expected http transport');
  expect(parsed.url).toBe('http://127.0.0.1:8787/mcp');

  expect(() =>
    mcpServerViewSchema.parse({
      name: 'bad',
      transport: 'http',
      url: 'ftp://example.com/mcp',
      auth: { mode: 'none' },
      enabled: true,
      trust: { autoApproveTools: [] }
    })
  ).toThrow();
});

test('peer base URLs accept HTTP for local/lan daemons but reject script schemes', () => {
  expect(
    peerViewSchema.parse({
      id: 'peer_01KABCDEF0123456789ABCDEFF',
      label: 'local',
      baseUrl: 'http://192.168.1.10:52749/openai',
      enabled: true
    }).baseUrl
  ).toBe('http://192.168.1.10:52749/openai');

  expect(() =>
    peerViewSchema.parse({
      id: 'peer_01KABCDEF0123456789ABCDEFG',
      label: 'bad',
      baseUrl: 'javascript:alert(1)',
      enabled: true
    })
  ).toThrow();
});

test('marketplace homepages are HTTPS-only external links', () => {
  expect(
    mcpRegistryEntrySchema.parse({
      id: 'server',
      registry: 'test',
      name: 'Server',
      description: 'desc',
      homepage: 'https://example.com',
      transport: 'stdio',
      command: 'npx',
      env: []
    }).homepage
  ).toBe('https://example.com');

  expect(() =>
    skillDetailSchema.parse({
      id: 'skill',
      source: 'clawhub',
      name: 'Skill',
      content: '',
      homepage: 'http://example.com',
      downloads: null,
      version: null,
      installSource: null
    })
  ).toThrow();
});
