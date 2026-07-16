import type { ModelMessage, ModelResult, ModelRouter } from '#/agent/index.ts';

import { describe, expect, test } from 'bun:test';

import { createHttpTransport } from '#/transports/http.ts';
import { buildHandlers, serveTransport, TRANSPORTS, type TransportKind } from '../../helpers.ts';

async function postJson<T>(
  transport: { fetch: (path: string, init?: RequestInit) => Promise<Response> },
  path: string,
  body: unknown
): Promise<T> {
  const response = await transport.fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  expect(response.status).toBeLessThan(300);
  return (await response.json()) as T;
}

describe('transport parity - steer', () => {
  for (const kind of TRANSPORTS) {
    test(`${kind}: ordered steer batch joins the active run after its current stream finishes`, async () => {
      let releaseFirstStream!: () => void;
      let markFirstStreamStarted!: () => void;
      const firstStreamStarted = new Promise<void>((resolve) => {
        markFirstStreamStarted = resolve;
      });
      const releaseFirst = new Promise<void>((resolve) => {
        releaseFirstStream = resolve;
      });
      const prompts: ModelMessage[][] = [];
      let streamCount = 0;
      const model: ModelRouter = {
        async *stream(request) {
          prompts.push(request.messages.slice());
          streamCount++;
          if (streamCount === 1) {
            markFirstStreamStarted();
            await releaseFirst;
            yield { type: 'text' as const, token: 'first answer' };
            return;
          }
          yield { type: 'text' as const, token: 'steered answer' };
        },
        async complete(): Promise<ModelResult> {
          return { text: 'unused', finishReason: 'stop' };
        }
      };
      const handlers = buildHandlers(model);
      const transport = serveTransport(kind as TransportKind, createHttpTransport(handlers));

      try {
        const { sessionId } = await postJson<{ sessionId: string }>(transport, '/v1/sessions', {
          title: `steer ${kind}`
        });
        await postJson(transport, `/v1/sessions/${sessionId}/messages`, { text: 'initial request' });
        await firstStreamStarted;
        await postJson(transport, `/v1/sessions/${sessionId}/messages`, {
          text: '',
          steer: true,
          steerMessages: ['change direction', 'keep it concise']
        });
        releaseFirstStream();

        for (let attempt = 0; attempt < 50 && handlers.store.listMessages(sessionId).length < 5; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        expect(prompts).toHaveLength(2);
        expect(prompts[1]?.at(-1)).toMatchObject({
          role: 'user',
          content: 'change direction\n\nkeep it concise'
        });
        expect(handlers.store.listMessages(sessionId).map((message) => message.text)).toEqual([
          'initial request',
          'first answer',
          'change direction',
          'keep it concise',
          'steered answer'
        ]);
      } finally {
        transport.stop();
        handlers.store.close();
      }
    });
  }
});
