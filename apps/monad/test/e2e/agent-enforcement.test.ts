// e2e: per-agent runtime enforcement (Studio) driven through the real HTTP turn over BOTH transports
// (TCP loopback + Unix socket). Covers the three runtime hooks wired in main.ts:
//   - agentToolFilter  → the per-agent atoms allowlist narrows the loop's tools (Stage B)
//   - agentSandboxRoots → the per-agent sandbox roots reach the tool ctx (#1)
//   - agent_delegate_to → named in-process delegation runs the target subagent (P2)
// The mock model is scripted per turn; tools record what actually ran via closures.

import type { ModelResult, ModelRouter } from '@/agent/index.ts';
import type { Tool, ToolContext } from '@/capabilities/tools/types.ts';

import { describe, expect, test } from 'bun:test';

import { toolResult } from '@/capabilities/tools/types.ts';
import { createAgentDelegateTool } from '@/services/delegation/agent-delegate.ts';
import { createHttpTransport } from '@/transports/http.ts';
import { buildHandlers, serveTransport, TRANSPORTS, type TransportHandle } from '../helpers.ts';

type Step = string | { tool: string; input?: unknown };

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

function recordTool(name: string, sink: { ran: boolean; roots?: string[] }): Tool<unknown, string> {
  return {
    name,
    description: name,
    scopes: [],
    run: async (_input, ctx: ToolContext) => {
      sink.ran = true;
      sink.roots = ctx.sandboxRoots;
      return toolResult(`${name} ran`);
    }
  };
}

async function createSession(t: TransportHandle): Promise<string> {
  const r = await t.fetch('/v1/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'x' })
  });
  return ((await r.json()) as { sessionId: string }).sessionId;
}

async function blockTurn(t: TransportHandle, sid: string, text: string): Promise<string> {
  const r = await t.fetch(`/v1/sessions/${sid}/messages/block`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text })
  });
  return ((await r.json()) as { message: { text: string } }).message.text;
}

function serve(kind: (typeof TRANSPORTS)[number], model: ModelRouter, opts: Parameters<typeof buildHandlers>[2]) {
  return serveTransport(kind, createHttpTransport(buildHandlers(model, undefined, opts)));
}

for (const kind of TRANSPORTS) {
  describe(`per-agent enforcement over ${kind}`, () => {
    test('agentToolFilter narrows out a denied tool while an admitted one still runs', async () => {
      const denied = { ran: false };
      const allowed = { ran: false };
      // The model tries the denied tool first (filtered out of availableTools → unknown-tool error),
      // then the admitted one (runs), then finishes. A second admitted tool keeps availableTools
      // non-empty so the loop stays in tool-calling mode across the blocked call.
      const t = serve(kind, scriptedModel([{ tool: 'pack.deny' }, { tool: 'pack.ok' }, 'done']), {
        tools: [recordTool('pack.deny', denied), recordTool('pack.ok', allowed)],
        agentToolFilter: () => (name) => name !== 'pack.deny'
      });
      try {
        const sid = await createSession(t);
        expect(await blockTurn(t, sid, 'go')).toBe('done');
        expect(denied.ran).toBe(false); // filtered out → never invoked
        expect(allowed.ran).toBe(true); // admitted → runs
      } finally {
        await t.stop();
      }
    });

    test('agentSandboxRoots reaches the tool execution context', async () => {
      const probe = { ran: false, roots: undefined as string[] | undefined };
      const root = '/tmp/monad-agent-root';
      const t = serve(kind, scriptedModel([{ tool: 'probe' }, 'done']), {
        tools: [recordTool('probe', probe)],
        agentSandboxRoots: () => [root]
      });
      try {
        const sid = await createSession(t);
        await blockTurn(t, sid, 'go');
        expect(probe.ran).toBe(true);
        expect(probe.roots).toEqual([root]); // per-agent root flowed loop → ToolContext.sandboxRoots
      } finally {
        await t.stop();
      }
    });

    test('agent_delegate_to runs the named subagent in-process', async () => {
      let innerInvoked = false;
      const innerModel: ModelRouter = {
        async *stream() {},
        async complete(): Promise<ModelResult> {
          innerInvoked = true;
          return { text: 'sub did the work', finishReason: 'stop' };
        }
      };
      const delegateTool = createAgentDelegateTool({
        agents: () => [{ name: 'helper', description: 'helps', atoms: { mode: 'inherit', allow: [], deny: [] } }],
        tools: () => [],
        toolSource: () => undefined,
        model: innerModel,
        defaultModel: 'mock'
      });
      const t = serve(
        kind,
        scriptedModel([
          { tool: 'agent_delegate_to', input: { agent: 'helper', instruction: 'do it' } },
          'outer summary'
        ]),
        { tools: [delegateTool] }
      );
      try {
        const sid = await createSession(t);
        expect(await blockTurn(t, sid, 'delegate please')).toBe('outer summary');
        expect(innerInvoked).toBe(true); // the named subagent actually executed
      } finally {
        await t.stop();
      }
    });
  });
}
