import type { RequestPermissionResponse, SessionNotification } from '@agentclientprotocol/sdk';
import type { ModelResult, ModelRouter } from '#/agent/index.ts';
import type { Tool } from '#/capabilities/tools/types.ts';

import { expect, test } from 'bun:test';
import { client as acpClient, ndJsonStream, PROTOCOL_VERSION, type Stream } from '@agentclientprotocol/sdk';

import { shellExecTool } from '#/capabilities/tools';
import { connectAcp } from '#/transports/acp/connection.ts';
import { buildHandlers } from '../helpers.ts';

type Step = string | { tool: string; input?: unknown };

function scriptedModel(steps: Step[]): ModelRouter {
  let i = 0;
  return {
    async *stream() {
      const step: Step = steps[i] ?? 'done';
      i++;
      if (typeof step === 'string') yield { type: 'text' as const, token: step };
      else
        yield {
          type: 'tool-call' as const,
          call: { toolCallId: `tc_${i}`, toolName: step.tool, input: step.input ?? {} }
        };
    },
    async complete(): Promise<ModelResult> {
      return { text: 'done', finishReason: 'stop' };
    }
  };
}

function pipe(): { agent: Stream; clientStream: Stream } {
  const c2a = new TransformStream<Uint8Array, Uint8Array>();
  const a2c = new TransformStream<Uint8Array, Uint8Array>();
  return {
    agent: ndJsonStream(a2c.writable, c2a.readable),
    clientStream: ndJsonStream(c2a.writable, a2c.readable)
  };
}

test('shell_exec output streams to the editor as in_progress tool_call_update content', async () => {
  const { agent, clientStream } = pipe();
  connectAcp(
    buildHandlers(
      scriptedModel([{ tool: 'shell_exec', input: { command: "printf 'streamed-output\\n'" } }, 'done']),
      undefined,
      {
        tools: [shellExecTool as Tool]
      }
    ),
    agent
  );
  const updates: SessionNotification[] = [];

  await acpClient()
    .onNotification('session/update', ({ params }) => {
      updates.push(params);
    })
    .onRequest(
      'session/request_permission',
      (): RequestPermissionResponse => ({
        outcome: { outcome: 'selected', optionId: 'allow' }
      })
    )
    .connectWith(clientStream, async (ctx) => {
      await ctx.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      const { sessionId } = await ctx.request('session/new', { cwd: '/tmp', mcpServers: [] });
      await ctx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'run it' }] });

      const streamed = updates
        .filter((u) => u.update.sessionUpdate === 'tool_call_update' && u.update.status === 'in_progress')
        .flatMap((u) => (u.update as { content?: Array<{ content?: { text?: string } }> }).content ?? [])
        .map((c) => c.content?.text ?? '')
        .join('');
      expect(streamed).toContain('streamed-output');
    });
});
