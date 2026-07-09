import type { Session, SessionId } from '@monad/protocol';
import type { ChatMessage, ModelChunk, ModelResult, ModelRouter } from '#/agent/index.ts';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { AgentLoop } from '#/agent/index.ts';
import { toolResult } from '#/capabilities/tools/types.ts';
import { createStore } from '#/store/db/index.ts';

const echoTool = {
  name: 'test.echo',
  description: 'echo',
  scopes: [],
  run: async ({ v }: { v: unknown }) => toolResult(`echoed:${JSON.stringify(v)}`)
};

/** A store-backed MessageRepo mirroring the daemon's adapter (apps/monad/src/main.ts): the assistant
 * text segments go through the open → markStreaming → settle lifecycle; tool/user rows append. */
function storeRepo(store: ReturnType<typeof createStore>) {
  const now = () => new Date().toISOString();
  return {
    list: (sessionId: string) => store.listMessagesWithLineage(sessionId) as ChatMessage[],
    append: (m: ChatMessage) =>
      store.insertMessage(m.id, m.sessionId, m.text, m.createdAt, m.role, {
        type: m.type,
        data: m.data,
        streamStatus: m.role === 'assistant' && (m.type ?? 'text') === 'text' ? 'complete' : 'settled',
        includeInContext: m.includeInContext
      }),
    open: (m: ChatMessage) =>
      store.insertMessage(m.id, m.sessionId, m.text, m.createdAt, m.role, {
        type: m.type,
        streamStatus: 'pending',
        includeInContext: m.includeInContext
      }),
    markStreaming: (sessionId: string, messageId: string) => {
      store.setGenStatus(sessionId, messageId, 'streaming', now());
    },
    settle: (m: ChatMessage, status: 'complete' | 'error') =>
      store.setGenStatus(m.sessionId, m.id, status, now(), { text: m.text, data: m.data, type: m.type })
  };
}

function fixtureSession(id: SessionId): Session {
  const ts = '2026-01-01T00:00:00Z';
  return {
    id,
    title: 't',
    ownerPrincipalId: newId('prn'),
    state: 'active',
    agentIds: [],
    parentSessionId: null,
    archived: false,
    restoreCount: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0
    },
    costUsd: 0,
    createdAt: ts,
    updatedAt: ts
  };
}

test('store-backed streaming tool turn persists ordered segments via the open→settle lifecycle', async () => {
  // step 0: preamble text + a tool call; step 1: the final answer.
  const script: { texts: string[]; call?: { toolCallId: string; toolName: string; input: unknown } }[] = [
    { texts: ['Let me ', 'check.'], call: { toolCallId: 'tc_1', toolName: 'test.echo', input: { v: 1 } } },
    { texts: ['The answer.'] }
  ];
  let i = 0;
  const model: ModelRouter = {
    async *stream(): AsyncGenerator<ModelChunk> {
      const s = script[i++] ?? { texts: ['fallback'] };
      for (const t of s.texts) yield { type: 'text', token: t };
      if (s.call) yield { type: 'tool-call', call: s.call };
    },
    async complete(): Promise<ModelResult> {
      return { text: '', finishReason: 'stop' };
    }
  };

  const store = createStore();
  const sid = newId('ses') as SessionId;
  store.insertSession(fixtureSession(sid));
  const loop = new AgentLoop({
    model,
    tools: [echoTool],
    messages: storeRepo(store),
    defaultModel: 'mock',
    emit: () => {}
  });

  await loop.runStream(sid, 'go');

  const rows = store.listMessages(sid);
  // Faithful interleaving by rowid: the preamble settles BEFORE its tool rows; the answer lands last.
  expect(rows.map((m) => ({ role: m.role, type: m.type, text: m.text }))).toEqual([
    { role: 'user', type: 'text', text: 'go' },
    { role: 'assistant', type: 'text', text: 'Let me check.' },
    { role: 'assistant', type: 'tool_call', text: expect.any(String) },
    { role: 'tool', type: 'tool_result', text: 'echoed:1' },
    { role: 'assistant', type: 'text', text: 'The answer.' }
  ]);
  // Both text segments went through the streaming lifecycle and settled to `complete` (no live source).
  const assistants = rows.filter((m) => m.role === 'assistant' && m.type === 'text');
  for (const a of assistants) {
    expect(a.stream.status).toBe('complete');
  }
  store.close();
});
