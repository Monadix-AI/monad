// e2e: verifies the tool_search deferred-mode pipeline against a real MCP subprocess.
// A "fat" MCP server exports 50 tools with long descriptions — enough to push the combined
// schema token estimate above the 8 000-token threshold. The test wires those tools into an
// AgentLoop using scripted models (no real LLM), then asserts:
//   1. Deferred mode activated — outer model only sees builtins + tool_search + tool_call.
//   2. tool_search dispatches an inner LLM call with the catalog and returns matching schemas.
//   3. tool_call executes the found tool via invokeTool and returns its result.

import type { McpServerConfig, MonadPaths } from '@monad/home';
import type { SessionId } from '@monad/protocol';
import type { ModelResult, ModelRouter } from '#/agent/index.ts';
import type { ToolGate } from '#/capabilities/tools/types.ts';

import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createDefaultConfig } from '@monad/home';
import { newId } from '@monad/protocol';

import { AgentLoop, InMemoryMessageRepo } from '#/agent/index.ts';
import { createToolCallTool } from '#/capabilities/tools/registry/tool-call.ts';
import { createToolSearchTool } from '#/capabilities/tools/registry/tool-search.ts';

const allowGate: ToolGate = async () => ({ allow: true });

import { connectMcpServers } from '#/bootstrap/mcp.ts';
import { AtomPackRegistry } from '#/handlers/atom-pack/index.ts';

const fixture = join(import.meta.dir, '../unit/tools/fixtures/fat-mcp-server.ts');

const paths: MonadPaths = {
  home: '/dev/null',
  runtime: '/dev/null',
  configs: '/dev/null',
  dbDir: '/dev/null',
  db: '/dev/null',
  config: '/dev/null/config.json',
  profile: '/dev/null/profile.json',
  approvals: '/dev/null/approvals.json',
  credentials: '/dev/null',
  auth: '/dev/null/auth.json',
  tls: '/dev/null/tls',
  workspace: '/dev/null',
  providers: '/dev/null',
  skills: '/dev/null',
  skillsLock: '/dev/null',
  locales: '/dev/null',
  mcp: '/dev/null',
  atoms: '/dev/null',
  packs: '/dev/null',
  agents: '/dev/null',
  memory: '/dev/null',
  backup: '/dev/null',
  cache: '/dev/null',
  bin: '/dev/null',
  sock: '/dev/null/s.sock',
  kvSock: '/dev/null/kv.sock',
  pid: '/dev/null/p.pid',
  logs: '/dev/null/d.log'
};

const fatServer = (): McpServerConfig => ({
  name: 'fat',
  transport: 'stdio',
  command: 'bun',
  args: [fixture],
  enabled: true,
  trust: { autoApproveTools: ['fat__tool_0'], hostEscape: false }
});

type Step = string | { tool: string; input?: unknown };
function toResult(step: Step, seq: number): ModelResult {
  if (typeof step === 'string') return { text: step, finishReason: 'stop' };
  return {
    text: '',
    toolCalls: [{ toolCallId: `tc_${seq}`, toolName: step.tool, input: step.input ?? {} }],
    finishReason: 'tool-calls'
  };
}

/** Outer model: scripted steps + captures tool list passed in each complete() call. */
function outerModel(steps: Step[]): { model: ModelRouter; seenToolLists: string[][] } {
  let i = 0;
  const seenToolLists: string[][] = [];
  const model: ModelRouter = {
    async *stream() {},
    async complete(req): Promise<ModelResult> {
      seenToolLists.push((req.tools ?? []).map((t) => t.name));
      const step = steps[i] ?? 'done';
      i++;
      return toResult(step, i);
    }
  };
  return { model, seenToolLists };
}

/** Inner model used by tool_search: returns the given tool name. */
function searchModel(toolName: string): ModelRouter {
  return {
    async *stream() {},
    async complete(): Promise<ModelResult> {
      return { text: toolName, finishReason: 'stop' };
    }
  };
}

let openHandle: Awaited<ReturnType<typeof connectMcpServers>> | undefined;
afterEach(async () => {
  if (openHandle) {
    for (const { conn } of openHandle.connections.values()) await conn.close();
    openHandle = undefined;
  }
});

test('deferred mode activates when fat MCP server registers 50 tools', async () => {
  const cfg = createDefaultConfig('prn_t00000000000', 't');
  cfg.mcpServers = [fatServer()];
  const registry = new AtomPackRegistry();
  openHandle = await connectMcpServers(cfg, paths, registry);

  // Verify the fat server registered 50 tools.
  const mcpTools = [...registry.tools.values()].filter((t) => t.name.startsWith('fat__'));
  expect(mcpTools.length).toBe(50);

  // Build meta-tools. fat__tool_0 is auto-approved, so it won't need a gate.
  const getAllTools = () => [...registry.tools.values()];
  const builtinToolNames = new Set<string>(['tool_search', 'tool_call']);
  const revision = () => registry.toolRevision;

  const toolSearchTool = createToolSearchTool({
    model: searchModel('fat__tool_0'),
    searchModelId: 'mock',
    getTools: getAllTools,
    getToolRevision: revision,
    builtinToolNames,
    topK: 3
  });
  const toolCallTool = createToolCallTool(getAllTools);

  // Scripted outer model:
  //  step 1 → call tool_search
  //  step 2 → call tool_call with the result
  //  step 3 → final answer
  const { model, seenToolLists } = outerModel([
    { tool: 'tool_search', input: { query: 'operation 0' } },
    { tool: 'tool_call', input: { name: 'fat__tool_0', args: { input: 'hello' } } },
    'all done'
  ]);

  const allTools = [...getAllTools(), toolSearchTool, toolCallTool];

  const loop = new AgentLoop({
    model,
    tools: allTools,
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {},
    gate: allowGate,
    toolSearchConfig: {
      searchTool: toolSearchTool,
      callTool: toolCallTool,
      builtinToolNames,
      threshold: 8_000
    }
  });

  const sid = newId('ses') as SessionId;
  const result = await loop.runBlock(sid, 'find and run operation 0');

  // ── assertion 1: deferred mode was activated ────────────────────────────────
  // The outer model's tools array should only contain meta-tools (no fat__* tools).
  const step1Tools = seenToolLists[0] ?? [];
  expect(step1Tools).toContain('tool_search');
  expect(step1Tools).toContain('tool_call');
  expect(step1Tools.some((n) => n.startsWith('fat__'))).toBe(false);
  expect(step1Tools.length).toBeLessThan(10);

  // ── assertion 2: the same small tool set is stable across all outer model steps ──
  for (const toolList of seenToolLists) {
    expect(toolList.some((n) => n.startsWith('fat__'))).toBe(false);
  }

  // ── assertion 3: final answer was returned ──────────────────────────────────
  expect(result.text).toBe('all done');
});

test('tool_search returns matching MCP tool schemas when queried', async () => {
  const cfg = createDefaultConfig('prn_t00000000000', 't');
  cfg.mcpServers = [fatServer()];
  const registry = new AtomPackRegistry();
  openHandle = await connectMcpServers(cfg, paths, registry);

  const getAllTools = () => [...registry.tools.values()];
  const builtinToolNames = new Set<string>(['tool_search', 'tool_call']);

  const toolSearchTool = createToolSearchTool({
    model: searchModel('fat__tool_5'),
    searchModelId: 'mock',
    getTools: getAllTools,
    getToolRevision: () => registry.toolRevision,
    builtinToolNames,
    topK: 3
  });

  const ctx = { sessionId: 'ses_100000000000', toolCallId: 'tc_1', log: () => {} };
  const result = await (toolSearchTool.run as (...args: unknown[]) => Promise<unknown>)({ query: 'operation 5' }, ctx);
  const modelContent = (result as { modelContent?: unknown }).modelContent;

  expect(typeof modelContent).toBe('string');
  expect(modelContent as string).toContain('## fat__tool_5');
  expect(modelContent as string).toContain('tool_call');
});

test('tool_call executes a real MCP tool and returns its output', async () => {
  const cfg = createDefaultConfig('prn_t00000000000', 't');
  cfg.mcpServers = [fatServer()];
  const registry = new AtomPackRegistry();
  openHandle = await connectMcpServers(cfg, paths, registry);

  const getAllTools = () => [...registry.tools.values()];
  const toolCallTool = createToolCallTool(getAllTools);

  const ctx = { sessionId: 'ses_100000000000', toolCallId: 'tc_1', log: () => {}, gate: allowGate };
  const result = await (toolCallTool.run as (...args: unknown[]) => Promise<unknown>)(
    { name: 'fat__tool_0', args: { input: 'world' } },
    ctx
  );
  const modelContent = (result as { modelContent?: unknown }).modelContent;

  expect(modelContent).toEqual([{ type: 'text', text: 'fat:tool_0:world' }]);
});
