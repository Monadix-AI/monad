// E2E proof of the capability both computer-use and browser-use depend on: an image returned by
// an MCP tool (a screenshot) must reach the model as an IMAGE content part on the next turn —
// not a JSON-stringified blob. Drives the real AgentLoop with a scripted model and the real MCP
// client connected to the mock stdio server (whose `screenshot` tool returns text + an image
// content block). If Phase 0's mcp.ts passthrough regresses, this fails.

import type { ModelChunk, ModelRequest, ModelResult, ModelRouter } from '@/agent/index.ts';

import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { newId } from '@monad/protocol';

import { createAgent } from '@/agent/index.ts';
import { connectMcpServer } from '@/capabilities/tools';
import { createStore } from '@/store/db/index.ts';

const fixture = join(import.meta.dir, '../unit/tools/fixtures/mock-mcp-server.ts');

// Turn 1: ask for a screenshot. Turn 2+: stop. Records every request so the test can inspect what
// the model actually received on the turn AFTER the tool ran.
function recordingModel(): { router: ModelRouter; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  const router: ModelRouter = {
    async *stream(req: ModelRequest): AsyncIterable<ModelChunk> {
      requests.push(req);
      if (requests.length === 1) {
        yield { type: 'tool-call', call: { toolCallId: 'tc1', toolName: 'mock__screenshot', input: {} } };
      } else {
        yield { type: 'text', token: 'done' };
      }
    },
    async complete(): Promise<ModelResult> {
      return { text: 'done', finishReason: 'stop' };
    }
  };
  return { router, requests };
}

test('a screenshot returned by an MCP tool reaches the model as an image content part', async () => {
  const conn = await connectMcpServer({ name: 'mock', command: 'bun', args: [fixture] });
  const screenshot = conn.tools.find((t) => t.name === 'mock__screenshot');
  if (!screenshot) throw new Error('mock server did not expose a screenshot tool');

  const store = createStore();
  const { router, requests } = recordingModel();
  const agent = createAgent({
    model: router,
    // Drop the high-risk flag so this test exercises the image path, not the approval gate.
    tools: [{ ...screenshot, highRisk: false }],
    sessionRepo: { insertSession: (s) => store.insertSession(s), getSession: (id) => store.getSession(id) },
    messageRepo: {
      list: (sessionId) => store.listMessages(sessionId),
      append: (m) => store.insertMessage(m.id, m.transcriptTargetId, m.text, m.createdAt, m.role)
    },
    defaultModel: 'mock'
  });

  const session = await agent.sessions.create('shot', newId('prn'));
  await agent.loop(() => {}).runStream(session.id, 'take a screenshot', new AbortController().signal);

  // The model must have been called at least twice (screenshot turn, then the follow-up turn that
  // sees the image), and that follow-up turn must carry an image content part with the PNG type.
  expect(requests.length).toBeGreaterThanOrEqual(2);
  const followup = requests[requests.length - 1];
  if (!followup) throw new Error('expected a follow-up model request');
  const imageParts = followup.messages.flatMap((m) =>
    Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image') : []
  );
  expect(imageParts.length).toBeGreaterThan(0);
  const first = imageParts[0];
  if (first?.type !== 'image') throw new Error('expected an image part');
  expect(first.mediaType).toBe('image/png');

  // And the base64 image must NOT have leaked into the text channel (persisted tool result).
  const toolResultText = followup.messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((p) => p.type === 'tool-result')
    .map((p) => (p.type === 'tool-result' ? p.output : ''))
    .join('');
  expect(toolResultText).not.toContain('iVBOR');

  await conn.close();
  store.close();
});
