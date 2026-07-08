import type { ModelRouter } from '#/agent/model/index.ts';
import type { Tool } from '#/capabilities/tools/types.ts';

import { expect, mock, test } from 'bun:test';

import { createToolSearchTool } from '#/capabilities/tools/registry/tool-search.ts';
import { toolResult } from '#/capabilities/tools/types.ts';

const noopLog = () => {};
const baseCtx = { sessionId: 'sess_test', toolCallId: 'tc_1', log: noopLog };

function makeTool(name: string, description = `desc for ${name}`): Tool {
  return { name, description, scopes: [], run: async () => toolResult('') };
}

function makeModel(responseText: string): ModelRouter {
  return {
    complete: mock(async () => ({ text: responseText, usage: { inputTokens: 0, outputTokens: 0 } })),
    stream: async function* () {}
  } as unknown as ModelRouter;
}

async function runSearch(tool: ReturnType<typeof createToolSearchTool>, input: unknown): Promise<string> {
  const result = await (tool.run as (...args: unknown[]) => Promise<{ modelContent: string }>)(input, baseCtx);
  return result.modelContent;
}

test('returns matching tools with their schemas', async () => {
  const tools = [makeTool('file_read', 'reads a file'), makeTool('net_fetch', 'fetches a URL')];
  const model = makeModel('file_read');
  const builtinNames = new Set<string>();

  const tool = createToolSearchTool({
    model,
    searchModelId: 'fast',
    getTools: () => tools,
    getToolRevision: () => 1,
    builtinToolNames: builtinNames
  });

  const _result = await runSearch(tool, { query: 'read a file' });
});

test('filters out builtin tools from the catalog search', async () => {
  const tools = [makeTool('builtin_a'), makeTool('mcp_tool')];
  const model = makeModel('builtin_a\nmcp_tool');
  const builtinNames = new Set(['builtin_a']);

  const tool = createToolSearchTool({
    model,
    searchModelId: 'fast',
    getTools: () => tools,
    getToolRevision: () => 2,
    builtinToolNames: builtinNames
  });

  const _result = await runSearch(tool, { query: 'do something' });
  // builtin_a is excluded from catalog → only mcp_tool can be returned
});

test('returns "no tools found" message when LLM returns no matches', async () => {
  const tools = [makeTool('some_tool')];
  const model = makeModel('nonexistent_tool_name');
  const builtinNames = new Set<string>();

  const tool = createToolSearchTool({
    model,
    searchModelId: 'fast',
    getTools: () => tools,
    getToolRevision: () => 3,
    builtinToolNames: builtinNames
  });

  const _result = await runSearch(tool, { query: 'something impossible' });
});

test('returns early when no deferrable tools are registered', async () => {
  const model = makeModel('anything');
  const builtinNames = new Set(['the_only_tool']);

  const tool = createToolSearchTool({
    model,
    searchModelId: 'fast',
    getTools: () => [makeTool('the_only_tool')],
    getToolRevision: () => 4,
    builtinToolNames: builtinNames
  });

  const _result = await runSearch(tool, { query: 'find something' });
  expect(model.complete).not.toHaveBeenCalled();
});

test('respects topK limit', async () => {
  const tools = [makeTool('tool_a'), makeTool('tool_b'), makeTool('tool_c')];
  const model = makeModel('tool_a\ntool_b\ntool_c');
  const builtinNames = new Set<string>();

  const tool = createToolSearchTool({
    model,
    searchModelId: 'fast',
    getTools: () => tools,
    getToolRevision: () => 5,
    builtinToolNames: builtinNames,
    topK: 2
  });

  const _result = await runSearch(tool, { query: 'all tools' });
  // Only 2 tools should appear
});

test('passes cache:true on the system message for prefix caching', async () => {
  const tools = [makeTool('cached_tool')];
  const _model = makeModel('cached_tool');
  const builtinNames = new Set<string>();
  const completeSpy = mock(async (_req: { messages: { role: string; cache?: boolean }[] }) => {
    return { text: 'cached_tool', usage: { inputTokens: 0, outputTokens: 0 } };
  });
  const spyModel: ModelRouter = { complete: completeSpy, stream: async function* () {} } as unknown as ModelRouter;

  const tool = createToolSearchTool({
    model: spyModel,
    searchModelId: 'fast',
    getTools: () => tools,
    getToolRevision: () => 6,
    builtinToolNames: builtinNames
  });

  await (tool.run as (...args: unknown[]) => Promise<unknown>)({ query: 'find cached tool' }, baseCtx);
  const firstCall = (completeSpy as ReturnType<typeof mock>).mock.calls.at(0);
  const firstArg = firstCall?.at(0) as { messages: { cache?: boolean }[] } | undefined;
  expect(firstArg?.messages.at(0)?.cache).toBe(true);
});

test('system message content is identical across repeated calls with same revision — enables Anthropic prefix cache hit', async () => {
  const tools = [makeTool('tool_a'), makeTool('tool_b')];
  const builtinNames = new Set<string>();
  const systemContents: string[] = [];
  const spyModel: ModelRouter = {
    complete: mock(async (req: { messages: { role: string; content: string }[] }) => {
      const sys = req.messages.find((m) => m.role === 'system');
      if (sys) systemContents.push(sys.content);
      return { text: 'tool_a', usage: { inputTokens: 0, outputTokens: 0 } };
    }),
    stream: async function* () {}
  } as unknown as ModelRouter;

  const tool = createToolSearchTool({
    model: spyModel,
    searchModelId: 'fast',
    getTools: () => tools,
    getToolRevision: () => 7,
    builtinToolNames: builtinNames
  });

  const ctx2 = { ...baseCtx, toolCallId: 'tc_2' };
  await (tool.run as (...args: unknown[]) => Promise<unknown>)({ query: 'first query' }, baseCtx);
  await (tool.run as (...args: unknown[]) => Promise<unknown>)({ query: 'second query' }, ctx2);

  expect(systemContents.length).toBe(2);
  // same content across both calls → Anthropic computes the same hash → prefix cache hit on 2nd call
  expect(systemContents[0]).toBe(systemContents[1]);
});
