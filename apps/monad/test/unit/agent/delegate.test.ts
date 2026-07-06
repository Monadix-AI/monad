import type { HookInput, Hooks } from '@monad/protocol';
import type { ModelResult, ModelRouter } from '@/agent/index.ts';
import type { Tool, ToolContext } from '@/capabilities/tools/types.ts';

import { expect, test } from 'bun:test';

import { createDelegateTool, runSubagent } from '@/capabilities/tools/registry/delegate.ts';
import { toolResult } from '@/capabilities/tools/types.ts';

// A scripted step is either a final text answer or a tool call the model requests.
type Step = string | { tool: string; input?: unknown };

/** Returns each scripted step once (text answer or tool call), then a fixed fallback. */
function scriptedModel(steps: Step[]): ModelRouter {
  let i = 0;
  return {
    async *stream() {},
    async complete(): Promise<ModelResult> {
      const step = i < steps.length ? (steps[i] as Step) : 'FALLBACK';
      i++;
      if (typeof step === 'string') return { text: step, finishReason: 'stop' };
      return {
        text: '',
        toolCalls: [{ toolCallId: `tc_${i}`, toolName: step.tool, input: step.input ?? {} }],
        finishReason: 'tool-calls'
      };
    }
  };
}

const ctx: ToolContext = { sessionId: 'sess_test', sandboxRoots: undefined, log: () => {} };

test('delegate returns the sub-agent final answer', async () => {
  const tool = createDelegateTool({ model: scriptedModel(['sub final answer']), tools: [], defaultModel: 'mock' });
  expect((await tool.run({ instruction: 'do x' }, ctx)).metadata).toEqual({ text: 'sub final answer' });
});

test('delegate threads hooks into the sub-agent — BeforeTool deny blocks the tool, caller is subagent', async () => {
  const seen: string[] = [];
  let ran = false;
  const echo: Tool<{ v: unknown }, string> = {
    name: 'test.echo',
    description: 'echo',
    scopes: [],
    run: async () => {
      ran = true;
      return toolResult('ok');
    }
  };
  const hooks: Hooks = {
    run: async (i: HookInput) => {
      seen.push(i.caller ? `${i.event}:${i.caller.kind}` : i.event);
      const deny = i.event === 'BeforeTool';
      return {
        blocked: deny,
        ask: false,
        allowed: false,
        reason: deny ? 'blocked by hook' : undefined,
        additionalContext: [],
        effectivePrompt: i.prompt,
        effectiveToolInput: i.toolInput,
        effectiveToolOutput: i.toolResult,
        effectiveRequest: i.request
      };
    }
  };
  const tool = createDelegateTool({
    model: scriptedModel([{ tool: 'test.echo' }, 'done']),
    tools: [echo],
    defaultModel: 'mock',
    hooks
  });
  await tool.run({ instruction: 'use echo' }, ctx);
  expect(seen).toContain('BeforeModel:subagent'); // hooks fire inside the delegated subagent, tagged subagent
  expect(seen).toContain('BeforeTool'); // the tool-path hook the delegate used to bypass now fires
  expect(ran).toBe(false); // and a BeforeTool deny actually blocks the tool
});

test('the sub-agent runs the tools it is given', async () => {
  let ran = false;
  const echo: Tool<{ v: unknown }, string> = {
    name: 'test.echo',
    description: 'echo',
    scopes: [],
    run: async ({ v }) => {
      ran = true;
      return toolResult(`echoed:${JSON.stringify(v)}`);
    }
  };
  const tool = createDelegateTool({
    model: scriptedModel([{ tool: 'test.echo', input: { v: 1 } }, 'done after tool']),
    tools: [echo],
    defaultModel: 'mock'
  });
  const out = await tool.run({ instruction: 'use echo' }, ctx);
  expect(ran).toBe(true);
  expect(out.metadata.text).toBe('done after tool');
});

test('agent_delegate is filtered out of the sub-agent toolset (no recursion)', async () => {
  let recursed = false;
  const fakeDelegate: Tool = {
    name: 'agent_delegate',
    description: 'x',
    scopes: [],
    run: async () => {
      recursed = true;
      return toolResult('recursed');
    }
  };
  const tool = createDelegateTool({ model: scriptedModel(['final']), tools: [fakeDelegate], defaultModel: 'mock' });
  await tool.run({ instruction: 'go' }, ctx);
  expect(recursed).toBe(false);
});

test('agent_delegate metadata is not high-risk', () => {
  const tool = createDelegateTool({ model: scriptedModel(['x']), tools: [], defaultModel: 'mock' });
  expect(tool.name).toBe('agent_delegate');
});

test('runSubagent throws when forkDepth reaches the limit', async () => {
  const model = scriptedModel(['answer']);
  await expect(
    runSubagent({ model, tools: [], defaultModel: 'mock', forkDepth: 3 }, 'task', { sessionId: 'ses_test' })
  ).rejects.toThrow('fork depth limit');
});

test('runSubagent succeeds when forkDepth is below the limit', async () => {
  const model = scriptedModel(['ok']);
  const result = await runSubagent({ model, tools: [], defaultModel: 'mock', forkDepth: 2 }, 'task', {
    sessionId: 'ses_test'
  });
  expect(result).toBe('ok');
});
