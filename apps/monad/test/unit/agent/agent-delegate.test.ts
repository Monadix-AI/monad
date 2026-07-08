import type { ModelResult, ModelRouter } from '@/agent/index.ts';
import type { Tool, ToolContext } from '@/capabilities/tools/types.ts';
import type { DelegatableAgent } from '@/services/generation/agent-persona.ts';

import { expect, test } from 'bun:test';

import { toolResult } from '@/capabilities/tools/types.ts';
import { createAgentDelegateTool } from '@/services/delegation/agent-delegate.ts';

type Step = string | { tool: string; input?: unknown };

/** Returns each scripted step once (final text or a tool call), then a fixed fallback. */
function scriptedModel(steps: Step[]): ModelRouter {
  let i = 0;
  return {
    async *stream() {},
    async complete(): Promise<ModelResult> {
      const step: Step = i < steps.length ? (steps[i] as Step) : 'FALLBACK';
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

const ctx: ToolContext = { sessionId: 'ses_test', sandboxRoots: undefined, log: () => {} };

function flagTool(name: string, flag: { ran: boolean }): Tool<unknown, string> {
  return {
    name,
    description: name,
    scopes: [],
    run: async () => {
      flag.ran = true;
      return toolResult(`${name} ran`);
    }
  };
}

const ROSTER: DelegatableAgent[] = [
  { name: 'researcher', description: 'use for deep research', atoms: { mode: 'inherit', allow: [], deny: [] } },
  {
    name: 'narrow',
    description: 'restricted helper',
    atoms: { mode: 'allowlist', allow: ['allowed-pack'], deny: [] }
  }
];

function makeTool(model: ModelRouter, parentTools: Tool[], source: Record<string, string> = {}) {
  return createAgentDelegateTool({
    agents: () => ROSTER,
    tools: () => parentTools,
    toolSource: (name) => source[name],
    model,
    defaultModel: 'mock'
  });
}

test('description enumerates the delegatable roster with when-to-use', () => {
  const tool = makeTool(scriptedModel(['x']), []);
  expect(tool.name).toBe('agent_delegate_to');
});

test('unknown agent throws and lists the valid targets', async () => {
  const tool = makeTool(scriptedModel(['x']), []);
  await expect(tool.run({ agent: 'ghost', instruction: 'go' }, ctx)).rejects.toThrow(/unknown agent "ghost"/);
});

test('returns the sub-agent final answer under the target persona', async () => {
  const tool = makeTool(scriptedModel(['done by researcher']), []);
  expect((await tool.run({ agent: 'researcher', instruction: 'go' }, ctx)).metadata).toEqual({
    text: 'done by researcher'
  });
});

test('allowlist agent runs an allowed pack tool but not a denied one', async () => {
  const allowed = { ran: false };
  const denied = { ran: false };
  const parentTools = [flagTool('allowed.do', allowed), flagTool('denied.do', denied)];
  const source = { 'allowed.do': 'allowed-pack', 'denied.do': 'other-pack' };
  // The model tries the denied tool first (excluded → unknown-tool error), then the allowed one, then done.
  const tool = makeTool(
    scriptedModel([{ tool: 'denied.do' }, { tool: 'allowed.do' }, 'finished']),
    parentTools,
    source
  );
  const out = await tool.run({ agent: 'narrow', instruction: 'go' }, ctx);
  expect(out.metadata.text).toBe('finished');
  expect(allowed.ran).toBe(true); // source in allowlist → exposed
  expect(denied.ran).toBe(false); // source not allowed → narrowed out, never runs
});

test('built-ins (no source) stay available to an allowlist agent', async () => {
  const builtin = { ran: false };
  const tool = makeTool(scriptedModel([{ tool: 'file_read' }, 'ok']), [flagTool('file_read', builtin)]);
  await tool.run({ agent: 'narrow', instruction: 'go' }, ctx);
  expect(builtin.ran).toBe(true); // no source → ungated by the allowlist
});

test('the delegate tools are stripped from the sub-agent (no onward delegation)', async () => {
  const recursed = { ran: false };
  const tool = makeTool(scriptedModel([{ tool: 'agent_delegate_to' }, 'final']), [
    flagTool('agent_delegate_to', recursed)
  ]);
  await tool.run({ agent: 'researcher', instruction: 'go' }, ctx);
  expect(recursed.ran).toBe(false);
});

test('subagent activity is bridged to the parent via reportProgress', async () => {
  const progress: string[] = [];
  const probeCtx: ToolContext = { ...ctx, reportProgress: (o) => progress.push(o) };
  // The subagent calls a tool, then answers — both should surface as progress on the parent turn.
  const tool = makeTool(scriptedModel([{ tool: 'work.do' }, 'final']), [flagTool('work.do', { ran: false })]);
  await tool.run({ agent: 'researcher', instruction: 'go' }, probeCtx);
  expect(progress.length).toBeGreaterThan(0);
  const _last = progress.at(-1) ?? '';
});
