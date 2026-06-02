import type { Tool, ToolGate } from '@/capabilities/tools/types.ts';

import { expect, test } from 'bun:test';

import { createToolCallTool } from '@/capabilities/tools/registry/tool-call.ts';
import { toolResult } from '@/capabilities/tools/types.ts';

const noopLog = () => {};
const baseCtx = { sessionId: 'sess_1', toolCallId: 'tc_1', log: noopLog };

const allowGate: ToolGate = async () => ({ allow: true });
const denyGate: ToolGate = async () => ({ allow: false, reason: 'denied' });

function echoTool(name: string, highRisk = false): Tool<{ msg: string }, string> {
  return {
    name,
    description: 'echoes msg',
    scopes: [],
    highRisk,
    run: async ({ msg }) => toolResult(`echo: ${msg}`)
  };
}

test('dispatches to the named tool and returns its result', async () => {
  const getTools = () => [echoTool('echo')];
  const tool = createToolCallTool(getTools);
  const result = await (tool.run as (...args: unknown[]) => Promise<unknown>)(
    { name: 'echo', args: { msg: 'hello' } },
    baseCtx
  );
  expect((result as { metadata: string }).metadata).toBe('echo: hello');
});

test('throws when tool name is not registered', async () => {
  const getTools = () => [echoTool('existing')];
  const tool = createToolCallTool(getTools);
  await expect(
    (tool.run as (...args: unknown[]) => Promise<unknown>)({ name: 'missing', args: {} }, baseCtx)
  ).rejects.toThrow(/No tool named "missing"/);
});

test('serializes non-string results to JSON', async () => {
  const jsonTool: Tool<Record<string, unknown>, Record<string, unknown>> = {
    name: 'json_tool',
    description: 'returns object',
    scopes: [],
    run: async () => toolResult({ count: 42, items: ['a', 'b'] })
  };
  const getTools = () => [jsonTool];
  const tool = createToolCallTool(getTools);
  const result = await (tool.run as (...args: unknown[]) => Promise<unknown>)({ name: 'json_tool', args: {} }, baseCtx);
  expect((result as { modelContent: string }).modelContent).toBe(JSON.stringify({ count: 42, items: ['a', 'b'] }));
});

test('high-risk dispatched tool requires a gate', async () => {
  const getTools = () => [echoTool('risky', true)];
  const tool = createToolCallTool(getTools);
  await expect(
    (tool.run as (...args: unknown[]) => Promise<unknown>)({ name: 'risky', args: { msg: 'x' } }, baseCtx)
  ).rejects.toThrow();
});

test('high-risk dispatched tool runs with an allowing gate', async () => {
  const getTools = () => [echoTool('risky', true)];
  const tool = createToolCallTool(getTools);
  const result = await (tool.run as (...args: unknown[]) => Promise<unknown>)(
    { name: 'risky', args: { msg: 'guarded' } },
    { ...baseCtx, gate: allowGate }
  );
  expect((result as { metadata: string }).metadata).toBe('echo: guarded');
});

test('high-risk dispatched tool denied by gate throws', async () => {
  const getTools = () => [echoTool('risky', true)];
  const tool = createToolCallTool(getTools);
  await expect(
    (tool.run as (...args: unknown[]) => Promise<unknown>)(
      { name: 'risky', args: { msg: 'x' } },
      { ...baseCtx, gate: denyGate }
    )
  ).rejects.toThrow(/denied/);
});

test('gateKey returns the dispatched tool name', () => {
  const tool = createToolCallTool(() => []);
  const key = tool.gateKey?.({ name: 'my_tool', args: {} });
  expect(key).toBe('my_tool');
});

test('tool is marked highRisk=true', () => {
  const tool = createToolCallTool(() => []);
  expect(tool.highRisk).toBe(true);
});
