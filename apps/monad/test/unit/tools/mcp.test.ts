import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';

import { connectMcpServer, type McpConnection } from '#/capabilities/tools';
import { normalizeMcpResult } from '#/capabilities/tools/registry/mcp';
import {
  invokeMcpAppBridge,
  issueMcpAppCapability,
  McpAppBridgeError
} from '#/capabilities/tools/registry/mcp/app-bridge.ts';

const fixture = join(import.meta.dir, 'fixtures', 'mock-mcp-server.ts');
let conn: McpConnection | null = null;

beforeAll(async () => {
  conn = await connectMcpServer({ name: 'mock', command: 'bun', args: [fixture] });
});
afterAll(async () => {
  if (conn) await conn.close();
});

const ctx = { sessionId: 's1', sandboxRoots: undefined, log: () => {} };

function toolByName(name: string) {
  if (!conn) throw new Error('mcp connection not initialized');
  const tool = conn.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`missing wrapped tool ${name}`);
  return tool;
}

test('connectMcpServer discovers and namespaces remote tools', () => {
  if (!conn) throw new Error('mcp connection not initialized');
  expect(conn.tools.map((t) => t.name)).toEqual(['mock__echo', 'mock__screenshot', 'mock__app']);
});

test('remote tools are high-risk (gated through the oversight layer)', () => {
  if (!conn) throw new Error('mcp connection not initialized');
  expect(conn.tools[0]?.highRisk).toBe(true);
  expect(conn.tools[0]?.scopes).toEqual([{ resource: 'mcp:mock' }]);
});

test('invoking a wrapped tool normalizes text content', async () => {
  const result = await toolByName('mock__echo').run({ text: 'ping' }, ctx);
  expect(result.metadata).toEqual({
    protocolVersion: '2025-06-18',
    protocolEra: 'legacy',
    text: 'ping',
    imageCount: 0
  });
});

test('remote tool arguments are validated against the advertised JSON Schema', () => {
  const schema = toolByName('mock__echo').inputSchema;
  const missing = schema?.safeParse({});
  const extra = schema?.safeParse({ text: 'ok', unexpected: true });
  const valid = schema?.safeParse({ text: 'ok' });

  expect({
    missing: missing?.success,
    extra: extra?.success,
    valid: valid?.success && valid.data
  }).toEqual({
    missing: false,
    extra: false,
    valid: { text: 'ok' }
  });
});

test('MCP App resources are prefetched and resource updates revoke stale capabilities', async () => {
  if (!conn) throw new Error('mcp connection not initialized');
  const first = await toolByName('mock__app').run({}, ctx);
  const firstDisplay = first.displayContent;
  if (firstDisplay?.type !== 'mcp_app' || !firstDisplay.bridgeId) throw new Error('missing MCP App display');
  const { token } = issueMcpAppCapability(firstDisplay.bridgeId, 's1');
  const resource = await invokeMcpAppBridge(token, {
    method: 'resources/read',
    params: { uri: 'ui://mock/app' }
  });

  await conn.callTool('echo', { text: 'refresh-app' });
  let refreshed = firstDisplay;
  for (let attempt = 0; attempt < 50 && refreshed.html === firstDisplay.html; attempt += 1) {
    await Bun.sleep(10);
    const output = await toolByName('mock__app').run({}, ctx);
    if (output.displayContent?.type === 'mcp_app') refreshed = output.displayContent;
  }
  const stale = await invokeMcpAppBridge(token, {
    method: 'resources/read',
    params: { uri: 'ui://mock/app' }
  }).catch((error) => error);

  expect({
    first: firstDisplay.html,
    refreshed: refreshed.html,
    resource,
    stale: stale instanceof McpAppBridgeError ? { message: stale.message, status: stale.status } : stale
  }).toEqual({
    first: '<main>app-v1</main>',
    refreshed: '<main>app-v2</main>',
    resource: {
      contents: [
        {
          uri: 'ui://mock/app',
          mimeType: 'text/html;profile=mcp-app',
          text: '<main>app-v1</main>',
          _meta: {
            ui: {
              csp: { connectDomains: ['https://example.com'] },
              permissions: { clipboardWrite: false }
            }
          }
        }
      ]
    },
    stale: { message: 'MCP App capability is invalid', status: 404 }
  });
});

test('callTool by raw name returns the raw content blocks', async () => {
  if (!conn) throw new Error('mcp connection not initialized');
  const out = await conn.callTool('echo', { text: 'direct' });
  expect(out).toEqual([{ type: 'text', text: 'direct' }]);
});

test('image content blocks stay off metadata but reach modelContent', async () => {
  const tool = toolByName('mock__screenshot');
  const output = await tool.run({}, ctx);

  // Text channel (what gets persisted / JSON.stringified) carries text + a count, never base64.
  expect(output.metadata).toEqual({
    protocolVersion: '2025-06-18',
    protocolEra: 'legacy',
    text: 'here is the screen',
    imageCount: 1
  });

  // Vision channel: modelContent surfaces the decoded image bytes for the model.
  const parts = output.modelContent;
  if (!Array.isArray(parts)) throw new Error('expected multimodal model content');
  const image = parts.find((p) => p.type === 'image');
  if (image?.type !== 'image') throw new Error('expected an image part');
  expect(image.mediaType).toBe('image/png');
  expect(image.image).toBeInstanceOf(Uint8Array);
  expect((image.image as Uint8Array).byteLength).toBeGreaterThan(0);
  expect(parts.some((p) => p.type === 'text' && p.text === 'here is the screen')).toBe(true);
});

test('MCP results enforce a hard model-context boundary', () => {
  const output = normalizeMcpResult({
    content: [{ type: 'text', text: 'x'.repeat(1024 * 1024 + 64) }]
  });

  expect({
    imageCount: output.imageCount,
    textBytes: Buffer.byteLength(output.text),
    truncated: output.truncated,
    suffix: output.text.endsWith('[MCP result truncated at 1048576 bytes]')
  }).toEqual({
    imageCount: 0,
    textBytes: 1024 * 1024 + 40,
    truncated: true,
    suffix: true
  });
});

test('list-changed notifications atomically replace the live MCP tool set', async () => {
  if (!conn) throw new Error('mcp connection not initialized');
  const revisions: string[][] = [];
  const unsubscribe = conn.onToolsChanged?.((tools) => revisions.push(tools.map((tool) => tool.name)));

  await conn.callTool('echo', { text: 'refresh-tools' });
  for (let attempt = 0; attempt < 50 && revisions.length === 0; attempt += 1) {
    await Bun.sleep(10);
  }
  unsubscribe?.();

  expect({
    live: conn.tools.map((tool) => tool.name),
    revisions
  }).toEqual({
    live: ['mock__echo', 'mock__screenshot', 'mock__app', 'mock__dynamic'],
    revisions: [['mock__echo', 'mock__screenshot', 'mock__app', 'mock__dynamic']]
  });
});

test('stdio server failure marks the connection unavailable and notifies subscribers once', async () => {
  const failing = await connectMcpServer({ name: 'failing', command: 'bun', args: [fixture] });
  const reasons: string[] = [];
  failing.onDisconnect?.((reason) => reasons.push(reason));

  await failing.callTool('echo', { text: 'crash-after-response' });
  for (let attempt = 0; attempt < 50 && reasons.length === 0; attempt += 1) await Bun.sleep(10);
  const reason = reasons[0];
  if (!reason) throw new Error('stdio disconnect notification was not delivered');

  expect({ failure: failing.failure, reasons }).toEqual({
    failure: reason,
    reasons: [reason]
  });
  await failing.close();
});
