import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';

import { connectMcpServer, type McpConnection } from '@/capabilities/tools';

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
  expect(conn.tools.map((t) => t.name)).toEqual(['mock__echo', 'mock__screenshot']);
});

test('remote tools are high-risk (gated through the oversight layer)', () => {
  if (!conn) throw new Error('mcp connection not initialized');
  expect(conn.tools[0]?.highRisk).toBe(true);
  expect(conn.tools[0]?.scopes).toEqual([{ resource: 'mcp:mock' }]);
});

test('invoking a wrapped tool normalizes text content', async () => {
  const result = await toolByName('mock__echo').run({ text: 'ping' }, ctx);
  expect(result.metadata).toEqual({ text: 'ping', imageCount: 0 });
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
  expect(output.metadata).toEqual({ text: 'here is the screen', imageCount: 1 });

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
