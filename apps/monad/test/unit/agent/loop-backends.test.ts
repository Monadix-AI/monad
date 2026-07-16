import type { Event, SessionId } from '@monad/protocol';
import type { ModelResult, ModelRouter } from '#/agent/index.ts';
import type { Tool, ToolBackends } from '#/capabilities/tools/types.ts';

import { expect, test } from 'bun:test';

import { AgentLoop, InMemoryMessageRepo } from '#/agent/index.ts';
import { fileGlobTool, fileWriteTool } from '#/capabilities/tools';
import { toolResult } from '#/capabilities/tools/types.ts';

type Step = string | { tool: string; input?: unknown };

function scriptedModel(steps: Step[]): ModelRouter {
  let i = 0;
  return {
    async *stream() {},
    async complete(): Promise<ModelResult> {
      const step = i < steps.length ? (steps[i] as Step) : 'done';
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

function run(
  steps: Step[],
  opts: { tools: Tool[]; backends?: ToolBackends; toolFilter?: (n: string) => boolean; extraTools?: Tool[] }
) {
  const events: Event[] = [];
  const loop = new AgentLoop({
    model: scriptedModel(steps),
    tools: opts.tools,
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: (e) => events.push(e),
    backends: opts.backends,
    toolFilter: opts.toolFilter,
    extraTools: opts.extraTools
  });
  return { loop, events };
}

test('file_write routes through an injected delegating backend, not the daemon disk', async () => {
  const writes: { path: string; content: string }[] = [];
  const backends: ToolBackends = {
    fs: {
      delegated: true,
      async readTextFile() {
        throw new Error('not found');
      },
      async writeTextFile(path, content) {
        writes.push({ path, content });
        return { path, bytesWritten: content.length };
      }
    },
    terminal: {
      delegated: true,
      async exec() {
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
      }
    }
  };
  // An absolute path outside any sandbox would throw in the sandbox backend; the delegating
  // backend accepts it (the editor owns the fs) and no gate fires because delegated === true.
  const { loop } = run([{ tool: 'file_write', input: { path: '/outside/x.txt', content: 'hi' } }, 'done'], {
    tools: [fileWriteTool as Tool],
    backends
  });
  await loop.runBlock('ses_100000000000' as SessionId, 'write a file');
  expect(writes).toEqual([{ path: '/outside/x.txt', content: 'hi' }]);
});

test('extraTools (e.g. per-session MCP tools) are available and callable this run', async () => {
  let ran = 0;
  const mcpTool: Tool = {
    name: 'mcp.echo',
    description: 'session-scoped MCP tool',
    scopes: [],
    async run() {
      ran++;
      return toolResult('echoed');
    }
  };
  const { loop, events } = run([{ tool: 'mcp.echo' }, 'done'], { tools: [], extraTools: [mcpTool] });
  await loop.runBlock('ses_100000000000' as SessionId, 'use the mcp tool');
  expect(ran).toBe(1);
  const result = events.find((e) => e.type === 'tool.result');
  expect(result?.payload).toMatchObject({ tool: 'mcp.echo', ok: true });
});

test('toolFilter hides a tool from execution (model gets unknown-tool)', async () => {
  // A second, unfiltered tool keeps tool-mode active so the filtered call reaches execution
  // and resolves to unknown-tool (rather than the loop skipping tools entirely).
  const { loop, events } = run([{ tool: 'fs_glob', input: { pattern: '*' } }, 'done'], {
    tools: [fileWriteTool as Tool, fileGlobTool as Tool],
    toolFilter: (n) => n !== 'fs_glob'
  });
  await loop.runBlock('ses_1' as SessionId, 'list files');
  const result = events.find((e) => e.type === 'tool.result');
  expect(result?.payload).toMatchObject({ tool: 'fs_glob', ok: false });
  expect(String((result?.payload as { result: string } | undefined)?.result)).toContain('unknown tool');
});
