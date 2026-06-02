import type { ModelRouter } from '#/agent/index.ts';

import { expect, test } from 'bun:test';

import { HandlerError } from '#/handlers/handler-error.ts';
import { buildHandlers, mockModel } from '../../helpers.ts';

const REPLY_RELATION_CONTROL_ERROR = {
  code: 'reply_relation_not_supported',
  kind: 'invalid',
  message: 'reply_relation_not_supported'
} as const;

async function controlPathResult(run: () => Promise<unknown>) {
  try {
    await run();
    return { accepted: true as const };
  } catch (error) {
    if (!(error instanceof HandlerError)) throw error;
    return { code: error.code, kind: error.kind, message: error.message };
  }
}

test('generate:false records the sender-selected reply relation on the new user message', async () => {
  const handlers = buildHandlers(mockModel(['unused']));
  const { sessionId } = await handlers.session.create({ title: 'reply relation' });
  await handlers.session.send({ generate: false, sessionId, text: 'original' });
  const original = (await handlers.session.messages({ id: sessionId })).messages[0];
  if (!original) throw new Error('expected original message');

  await handlers.session.send({
    generate: false,
    replyToMessageId: original.id,
    sessionId,
    text: 'follow up'
  });

  const messages = (await handlers.session.messages({ id: sessionId })).messages;
  expect(messages.map(({ role, text, replyToMessageId }) => ({ role, text, replyToMessageId }))).toEqual([
    { role: 'user', text: 'original', replyToMessageId: undefined },
    { role: 'user', text: 'follow up', replyToMessageId: original.id }
  ]);
});

test('normal, inline, and blocking slash commands preserve the sender-selected relation on the directive echo', async () => {
  const handlers = buildHandlers(mockModel(['unused']));
  const results: Array<{
    path: string;
    replyToMessageId: string | undefined;
    targetId: string;
    text: string;
    type: string;
  }> = [];

  for (const path of ['normal', 'inline', 'block'] as const) {
    const { sessionId } = await handlers.session.create({ title: `reply slash ${path}` });
    await handlers.session.send({ generate: false, sessionId, text: 'original' });
    const original = (await handlers.session.messages({ id: sessionId })).messages[0];
    if (!original) throw new Error('expected original message');

    if (path === 'normal') {
      await handlers.session.send({ sessionId, text: '/help', replyToMessageId: original.id });
    } else if (path === 'inline') {
      await handlers.session.sendInline({ sessionId, text: '/help', replyToMessageId: original.id }, () => {});
    } else {
      await handlers.session.generate({ sessionId, text: '/help', replyToMessageId: original.id });
    }

    const echo = (await handlers.session.messages({ id: sessionId })).messages.find(
      (message) => message.role === 'user' && message.text === '/help'
    );
    if (!echo) throw new Error(`expected ${path} command echo`);
    results.push({
      path,
      replyToMessageId: echo.replyToMessageId,
      targetId: original.id,
      text: echo.text,
      type: echo.type
    });
  }

  expect(results).toEqual(
    results.map(({ path, targetId }) => ({
      path,
      replyToMessageId: targetId,
      targetId,
      text: '/help',
      type: 'directive'
    }))
  );
});

test('reply relations are rejected consistently before steer and history-continuation routing', async () => {
  const results: Array<{ path: string; result: Awaited<ReturnType<typeof controlPathResult>> }> = [];

  for (const path of [
    'idle-steer',
    'history-send',
    'history-inline',
    'steer-inline',
    'block-steer',
    'block-history'
  ] as const) {
    const handlers = buildHandlers(mockModel(['done']));
    const { sessionId } = await handlers.session.create({ title: path });
    await handlers.session.send({ generate: false, sessionId, text: 'original' });
    const original = (await handlers.session.messages({ id: sessionId })).messages[0];
    if (!original) throw new Error(`expected ${path} reply target`);

    const result = await controlPathResult(() => {
      if (path === 'idle-steer') {
        return handlers.session.send({
          replyToMessageId: original.id,
          sessionId,
          steer: true,
          text: 'redirect'
        });
      }
      if (path === 'history-send') {
        return handlers.session.send({
          continueFromHistory: true,
          replyToMessageId: original.id,
          sessionId,
          text: ''
        });
      }
      if (path === 'block-steer') {
        return handlers.session.generate({
          replyToMessageId: original.id,
          sessionId,
          steer: true,
          text: 'redirect'
        });
      }
      if (path === 'block-history') {
        return handlers.session.generate({
          continueFromHistory: true,
          replyToMessageId: original.id,
          sessionId,
          text: ''
        });
      }
      if (path === 'steer-inline') {
        return handlers.session.sendInline(
          {
            replyToMessageId: original.id,
            sessionId,
            steer: true,
            text: 'redirect'
          },
          () => {}
        );
      }
      return handlers.session.sendInline(
        {
          continueFromHistory: true,
          replyToMessageId: original.id,
          sessionId,
          text: ''
        },
        () => {}
      );
    });
    results.push({ path, result });
  }

  expect(results).toEqual([
    { path: 'idle-steer', result: REPLY_RELATION_CONTROL_ERROR },
    { path: 'history-send', result: REPLY_RELATION_CONTROL_ERROR },
    { path: 'history-inline', result: REPLY_RELATION_CONTROL_ERROR },
    { path: 'steer-inline', result: REPLY_RELATION_CONTROL_ERROR },
    { path: 'block-steer', result: REPLY_RELATION_CONTROL_ERROR },
    { path: 'block-history', result: REPLY_RELATION_CONTROL_ERROR }
  ]);
});

test('inline send propagates a pre-header client abort to the subsequently created model run', async () => {
  let modelSawAbortedSignal = false;
  const model: ModelRouter = {
    async *stream(request) {
      modelSawAbortedSignal = request.signal?.aborted ?? false;
      request.signal?.throwIfAborted();
      yield { type: 'text' as const, token: 'unexpected' };
    },
    async complete() {
      return { text: 'unused' };
    }
  };
  const handlers = buildHandlers(model);
  const { sessionId } = await handlers.session.create({ title: 'pre-header abort' });
  const controller = new AbortController();
  controller.abort(new Error('client disconnected before SSE headers'));

  let errorMessage: string | undefined;
  try {
    await handlers.session.sendInline({ sessionId, text: 'cancel this turn' }, () => {}, {
      signal: controller.signal,
      transport: 'http'
    });
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  expect({ errorMessage, modelSawAbortedSignal }).toEqual({
    errorMessage: 'client disconnected before SSE headers',
    modelSawAbortedSignal: true
  });
});
