// The agent's tool list can be a LIVE getter, so a hot-installed tool (the daemon mutating the
// registry the getter reads) reaches the running agent without a rebuild — the same contract that
// lets atom-pack/MCP installs take effect without a daemon restart.

import type { ModelResult, ModelRouter } from '@/agent/index.ts';
import type { Tool, ToolContext } from '@/capabilities/tools/types.ts';

import { expect, test } from 'bun:test';

import { createAgent } from '@/agent/index.ts';
import { createDelegateTool } from '@/capabilities/tools/registry/delegate.ts';
import { toolResult } from '@/capabilities/tools/types.ts';

const mkTool = (name: string): Tool => ({ name, description: name, scopes: [], run: async () => toolResult('ok') });
const sessionRepo = { insertSession: () => {}, getSession: () => null };
const names = (ts: Tool[]): string[] => ts.map((t) => t.name).sort();

test('a function `tools` is resolved live — a tool added after createAgent appears', () => {
  const live: Tool[] = [mkTool('a')];
  const agent = createAgent({ sessionRepo, tools: () => [...live] });

  expect(names(agent.tools)).toEqual(['a']);
  live.push(mkTool('b')); // simulate a hot install mutating the registry
  expect(names(agent.tools)).toEqual(['a', 'b']);
  live.splice(0, live.length); // simulate a removal
  expect(agent.tools).toEqual([]);
});

test('a plain-array `tools` still works (backward compatible)', () => {
  const agent = createAgent({ sessionRepo, tools: [mkTool('x')] });
  expect(names(agent.tools)).toEqual(['x']);
});

test('toolsVersion memoizes the composed tools — same reference until the version bumps', () => {
  let live: Tool[] = [mkTool('a')];
  let version = 1;
  const agent = createAgent({ sessionRepo, tools: () => [...live], toolsVersion: () => version });

  const first = agent.tools;
  expect(names(first)).toEqual(['a']);
  expect(agent.tools).toBe(first); // same version → memo hit, no rebuild, no allocation

  // A change without a version bump is trusted-stale (the daemon always bumps on a real change).
  live = [mkTool('a'), mkTool('b')];
  expect(agent.tools).toBe(first);

  // Bump → recompute against the live getter → new reference + new tools.
  version = 2;
  const second = agent.tools;
  expect(second).not.toBe(first);
  expect(names(second)).toEqual(['a', 'b']);
});

test('without toolsVersion the composed tools are recomputed live every read', () => {
  const live: Tool[] = [mkTool('a')];
  const agent = createAgent({ sessionRepo, tools: () => [...live] });
  const first = agent.tools;
  live.push(mkTool('b'));
  expect(agent.tools).not.toBe(first); // no memo → fresh each read
  expect(names(agent.tools)).toEqual(['a', 'b']);
});

// A scripted model that calls one tool by name, then answers.
function callThen(toolName: string, answer: string): ModelRouter {
  let i = 0;
  return {
    async *stream() {},
    async complete(): Promise<ModelResult> {
      i++;
      if (i === 1)
        return { text: '', toolCalls: [{ toolCallId: 'tc1', toolName, input: {} }], finishReason: 'tool-calls' };
      return { text: answer, finishReason: 'stop' };
    }
  };
}

test('delegate resolves its subagent toolset live — runs a tool installed after construction', async () => {
  const live: Tool[] = [];
  let ran = false;
  const tool = createDelegateTool({
    model: callThen('late.tool', 'done'),
    tools: () => [...live],
    defaultModel: 'mock'
  });

  // The tool is "installed" only after the delegate tool was built.
  live.push({
    name: 'late.tool',
    description: 'late',
    scopes: [],
    run: async () => {
      ran = true;
      return toolResult('ok');
    }
  });

  const ctx: ToolContext = { sessionId: 'sess_test', sandboxRoots: undefined, log: () => {} };
  const out = await tool.run({ instruction: 'use it' }, ctx);
  expect(ran).toBe(true);
  expect(out.metadata.text).toBe('done');
});
