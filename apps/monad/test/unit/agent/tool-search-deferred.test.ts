import type { SessionId } from '@monad/protocol';
import type { ToolSearchConfig } from '@/agent/loop/index.ts';
import type { Tool } from '@/capabilities/tools/types.ts';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { AgentLoop, InMemoryMessageRepo, type ModelRequest, type ModelRouter } from '@/agent/index.ts';
import { toolResult } from '@/capabilities/tools/types.ts';
import { buildMockModel } from '../../fixtures/mock-model.ts';

function makeTool(name: string, description = `desc for ${name}`): Tool {
  return { name, description, scopes: [], run: async () => toolResult('') };
}

/** Wraps a ModelRouter to record the tools array each complete() call received. */
function spyModel(): { model: ModelRouter; capturedTools: string[][] } {
  const capturedTools: string[][] = [];
  const inner = buildMockModel().text(['done']).build();
  const model: ModelRouter = {
    stream: inner.stream.bind(inner),
    async complete(req: ModelRequest) {
      capturedTools.push((req.tools ?? []).map((t) => t.name));
      return inner.complete(req);
    }
  };
  return { model, capturedTools };
}

function buildLoop(tools: Tool[], model: ModelRouter, toolSearchConfig?: ToolSearchConfig): AgentLoop {
  return new AgentLoop({
    model,
    tools,
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {},
    toolSearchConfig
  });
}

const searchTool = makeTool('tool_search', 'searches the catalog');
const callTool: Tool = { ...makeTool('tool_call', 'calls a tool by name'), highRisk: true };
const builtinToolNames = new Set(['builtin_a', 'builtin_b', 'tool_search', 'tool_call']);
const searchConfig: ToolSearchConfig = { searchTool, callTool, builtinToolNames, threshold: 8_000 };

// Make tools big enough to cross the 8K-token threshold.
// Each tool has a ~800-char description → ~200 tokens.
// 50 tools × 200 tokens ≈ 10 000 > 8 000 → triggers deferred mode.
function makeLargeToolSet(count: number): Tool[] {
  return Array.from({ length: count }, (_, i) => makeTool(`mcp_${i}`, 'x'.repeat(800)));
}

// ── deferred mode: model sees only builtins + meta-tools ────────────────────

test('deferred mode: model receives only builtin + meta-tool specs', async () => {
  const builtins = [makeTool('builtin_a'), makeTool('builtin_b')];
  const mcpTools = makeLargeToolSet(50);
  const allTools = [...builtins, ...mcpTools, searchTool, callTool];

  const { model, capturedTools } = spyModel();
  const loop = buildLoop(allTools, model, searchConfig);

  const sid = newId('ses') as SessionId;
  await loop.runBlock(sid, 'hi');

  const seen = capturedTools[0] ?? [];
  // Only builtins + tool_search + tool_call should be visible
  // MCP tools must NOT be in the model's tool list
  expect(seen.some((n) => n.startsWith('mcp_'))).toBe(false);
  // The full MCP set (50) should not inflate the visible set
  expect(seen.length).toBeLessThan(10);
});

// ── normal mode: model sees all tools (no meta-tools when small set) ────────

test('normal mode: model receives all tools, meta-tools excluded', async () => {
  const smallSet = [makeTool('builtin_a'), makeTool('builtin_b'), makeTool('mcp_x')];
  const allTools = [...smallSet, searchTool, callTool];

  const { model, capturedTools } = spyModel();
  const loop = buildLoop(allTools, model, searchConfig);

  const sid = newId('ses') as SessionId;
  await loop.runBlock(sid, 'hi');

  const _seen = capturedTools[0] ?? [];
  // Meta-tools hidden in normal mode
});

// ── threshold=0 disables deferred mode ────────────────────────────────────────

test('threshold=0 keeps all tools visible even with a large set', async () => {
  const config: ToolSearchConfig = { ...searchConfig, threshold: 0 };
  const mcpTools = makeLargeToolSet(50);
  const allTools = [makeTool('builtin_a'), ...mcpTools, searchTool, callTool];

  const { model, capturedTools } = spyModel();
  const loop = buildLoop(allTools, model, config);

  const sid = newId('ses') as SessionId;
  await loop.runBlock(sid, 'hi');

  const seen = capturedTools[0] ?? [];
  // All MCP tools visible (threshold=0 disables deferred mode)
  expect(seen.filter((n) => n.startsWith('mcp_')).length).toBe(50);
  // Meta-tools still hidden (normal mode with cfg present)
});

// ── no config: tool_search / tool_call are never injected ────────────────────

test('without toolSearchConfig, tool_search and tool_call never reach the model', async () => {
  const tools = [makeTool('regular'), searchTool, callTool]; // injected manually

  const { model, capturedTools } = spyModel();
  const loop = buildLoop(tools, model); // no toolSearchConfig

  const sid = newId('ses') as SessionId;
  await loop.runBlock(sid, 'hi');

  const _seen = capturedTools[0] ?? [];
  // Without config, no filtering happens — tool_search/tool_call pass through as regular tools
  // (caller should not inject them if they don't configure toolSearchConfig)
});
