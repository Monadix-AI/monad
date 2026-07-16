import type { ModelMessage, ModelResult, ModelRouter } from '#/agent/index.ts';

import { expect, test } from 'bun:test';

import { buildHandlers } from '../../helpers.ts';

test('session send accepts steer into the active run without aborting its current stream', async () => {
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
  const { sessionId } = await handlers.session.create({ title: 'steer test' });

  await handlers.session.send({ sessionId, text: 'initial request' });
  await firstStreamStarted;
  await expect(handlers.session.send({ sessionId, text: 'change direction', steer: true })).resolves.toEqual({
    accepted: true
  });

  releaseFirstStream();
  for (let attempt = 0; attempt < 50 && prompts.length < 2; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  expect(prompts).toHaveLength(2);
  expect(prompts[1]?.at(-1)).toMatchObject({ role: 'user', content: 'change direction' });
  expect(handlers.store.listMessages(sessionId).map((message) => message.text)).toEqual([
    'initial request',
    'first answer',
    'change direction',
    'steered answer'
  ]);
  handlers.store.close();
});

test('session send accepts a steer batch as separate user messages before one model continuation', async () => {
  let releaseFirstStream!: () => void;
  let markFirstStreamStarted!: () => void;
  const firstStreamStarted = new Promise<void>((resolve) => {
    markFirstStreamStarted = resolve;
  });
  const releaseFirst = new Promise<void>((resolve) => {
    releaseFirstStream = resolve;
  });
  const prompts: ModelMessage[][] = [];
  const model: ModelRouter = {
    async *stream(request) {
      prompts.push(request.messages.slice());
      if (prompts.length === 1) {
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
  const { sessionId } = await handlers.session.create({ title: 'batch steer test' });

  await handlers.session.send({ sessionId, text: 'initial request' });
  await firstStreamStarted;
  await handlers.session.send({
    sessionId,
    text: '',
    steer: true,
    steerMessages: ['first adjustment', 'second adjustment']
  });
  releaseFirstStream();
  for (let attempt = 0; attempt < 50 && prompts.length < 2; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  expect(prompts).toHaveLength(2);
  expect(prompts[1]?.at(-1)).toMatchObject({
    role: 'user',
    content: 'first adjustment\n\nsecond adjustment'
  });
  expect(handlers.store.listMessages(sessionId).map((message) => message.text)).toEqual([
    'initial request',
    'first answer',
    'first adjustment',
    'second adjustment',
    'steered answer'
  ]);
  handlers.store.close();
});
