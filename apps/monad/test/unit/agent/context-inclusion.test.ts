import type { ChatMessage } from '#/agent/index.ts';

import { afterEach, expect, test } from 'bun:test';
import { registerMessageType, unregisterMessageType } from '@monad/protocol';
import { z } from 'zod';

import { replayHistory } from '#/agent/index.ts';

function msg(id: string, text: string, role: ChatMessage['role'] = 'user'): ChatMessage {
  return { id, sessionId: 'ses_1', role, text, createdAt: '2026-01-01T00:00:00Z' } as ChatMessage;
}

afterEach(() => unregisterMessageType('demo:note'));

test('a per-message includeInContext:false override drops the message from the prompt', () => {
  const history: ChatMessage[] = [
    msg('m1', 'hello'),
    { ...msg('m2', 'secret ui note', 'assistant'), includeInContext: false },
    msg('m3', 'goodbye', 'assistant')
  ];
  expect(replayHistory(history).map((m) => m.content)).toEqual(['hello', 'goodbye']);
});

test('a per-message includeInContext:true override re-includes an otherwise-excluded type', () => {
  const history: ChatMessage[] = [
    msg('m1', 'hello'),
    { ...msg('m2', 'kept directive', 'assistant'), type: 'directive', includeInContext: true }
  ];
  expect(replayHistory(history).map((m) => m.content)).toEqual(['hello', 'kept directive']);
});

test('an atom type registered with includeInContext:false is excluded from the prompt', () => {
  registerMessageType('demo', { type: 'note', dataSchema: z.unknown(), fallbacks: ['text'], includeInContext: false });
  const history: ChatMessage[] = [
    msg('m1', 'hello'),
    { ...msg('m2', 'atom-pack chrome', 'assistant'), type: 'demo:note' },
    msg('m3', 'world')
  ];
  expect(replayHistory(history).map((m) => m.content)).toEqual(['hello\n\nworld']);
});
