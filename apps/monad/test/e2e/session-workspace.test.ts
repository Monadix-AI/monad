// e2e: a session's working folder (session.cwd) reaches tool execution as a sandbox root over BOTH
// transports — and, critically, does so even when the in-memory runtime map is empty (the daemon-
// restart condition: cwd persisted in the store, applyWorkspaceRuntime not yet re-run). This pins the
// #1 fix in messaging.ts (sandboxRootsFor falls back to the persisted session.cwd).

import type { Session } from '@monad/protocol';
import type { ModelResult, ModelRouter } from '@/agent/index.ts';
import type { Tool, ToolContext } from '@/capabilities/tools/types.ts';

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId } from '@monad/protocol';

import { toolResult } from '@/capabilities/tools/types.ts';
import { createStore } from '@/store/db/index.ts';
import { createHttpTransport } from '@/transports/http.ts';
import { buildHandlers, serveTransport, TRANSPORTS, type TransportHandle } from '../helpers.ts';

function scriptedModel(steps: (string | { tool: string })[]): ModelRouter {
  let i = 0;
  return {
    async *stream() {},
    async complete(): Promise<ModelResult> {
      const step = (i < steps.length ? steps[i] : 'done') as string | { tool: string };
      i++;
      if (typeof step === 'string') return { text: step, finishReason: 'stop' };
      return {
        text: '',
        toolCalls: [{ toolCallId: `tc_${i}`, toolName: step.tool, input: {} }],
        finishReason: 'tool-calls'
      };
    }
  };
}

function probeTool(sink: { roots?: string[] }): Tool<unknown, string> {
  return {
    name: 'probe',
    description: 'probe',
    scopes: [],
    run: async (_input, ctx: ToolContext) => {
      sink.roots = ctx.sandboxRoots;
      return toolResult('probed');
    }
  };
}

function fixtureSession(over: Partial<Session>): Session {
  const now = new Date().toISOString();
  return {
    id: newId('ses'),
    title: 'room',
    ownerPrincipalId: newId('prn'),
    state: 'active',
    agentIds: [],
    parentSessionId: null,
    archived: false,
    restoreCount: 0,
    createdAt: now,
    updatedAt: now,
    ...over
  };
}

async function blockTurn(t: TransportHandle, sid: string): Promise<void> {
  await t.fetch(`/v1/sessions/${sid}/messages/block`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'go' })
  });
}

for (const kind of TRANSPORTS) {
  describe(`session working folder over ${kind}`, () => {
    test('persisted session.cwd reaches the tool sandbox after a restart (empty runtime map)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'monad-ws-e2e-'));
      const store = createStore();
      // Persist a session with a working folder WITHOUT going through create() — so the served
      // handlers' runtime map is empty, exactly as it is on a fresh daemon boot.
      const session = fixtureSession({ cwd: dir });
      store.insertSession(session);

      const probe = { roots: undefined as string[] | undefined };
      const t = serveTransport(
        kind,
        createHttpTransport(
          buildHandlers(scriptedModel([{ tool: 'probe' }, 'done']), undefined, { store, tools: [probeTool(probe)] })
        )
      );
      try {
        await blockTurn(t, session.id);
        expect(probe.roots).toEqual([dir]); // fallback to persisted cwd, not the global default
      } finally {
        await t.stop();
      }
    });
  });
}
