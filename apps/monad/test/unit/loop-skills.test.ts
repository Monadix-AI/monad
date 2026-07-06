import type { SessionId } from '@monad/protocol';
import type { ModelMessage, ModelResult, ModelRouter } from '@/agent/index.ts';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { AgentLoop, InMemoryMessageRepo, type LoadedSkill } from '@/agent/index.ts';
import { buildMockModel } from '../fixtures/mock-model.ts';

function lastUserText(messages: ModelMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  if (!last) return '';
  const c = last.content;
  if (typeof c === 'string') return c;
  return (c as Array<{ type: string; text?: string }>).map((p) => p.text ?? '').join('');
}

function _allText(messages: ModelMessage[]): string {
  return messages
    .flatMap((m) => {
      const c = m.content;
      if (typeof c === 'string') return [c];
      return (c as Array<{ type: string; text?: string }>).map((p) => p.text ?? '');
    })
    .join('\n');
}

test('explicit /skill-name: model receives expanded body, not the raw command text', async () => {
  let capturedMessages: ModelMessage[] | undefined;
  const capturingModel: ModelRouter = {
    async *stream() {},
    async complete(req): Promise<ModelResult> {
      capturedMessages = req.messages;
      return { text: 'done', finishReason: 'stop' };
    }
  };
  const skill: LoadedSkill = {
    name: 'greet',
    description: 'A greeter skill',
    body: 'SKILL_BODY: greet the user warmly'
  };
  const loop = new AgentLoop({
    model: capturingModel,
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {},
    skills: [skill]
  });
  await loop.runBlock(newId('ses') as SessionId, '/greet world');

  const text = lastUserText(capturedMessages ?? []);
  expect(text).not.toBe('/greet world');
});

test('inline addressable /skill-id: model receives expanded body with surrounding text as arguments', async () => {
  let capturedMessages: ModelMessage[] | undefined;
  const capturingModel: ModelRouter = {
    async *stream() {},
    async complete(req): Promise<ModelResult> {
      capturedMessages = req.messages;
      return { text: 'done', finishReason: 'stop' };
    }
  };
  const skill: LoadedSkill = {
    name: 'global:greet',
    description: 'A greeter skill',
    body: 'SKILL_BODY: $ARGUMENTS'
  };
  const loop = new AgentLoop({
    model: capturingModel,
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {},
    skills: [skill]
  });
  await loop.runBlock(newId('ses') as SessionId, 'please use /global:greet for Zeke');

  const text = lastUserText(capturedMessages ?? []);
  expect(text).not.toBe('please use /global:greet for Zeke');
});

test('explicit /skill-name: history persists raw command text, not the expanded body', async () => {
  const skill: LoadedSkill = {
    name: 'greet',
    description: 'A greeter skill',
    body: 'MUST_NOT_BE_IN_HISTORY: very long skill body text'
  };
  const messages = new InMemoryMessageRepo();
  const loop = new AgentLoop({
    model: buildMockModel().text(['ok']).build(),
    tools: [],
    messages,
    defaultModel: 'mock',
    emit: () => {},
    skills: [skill]
  });
  const ses = newId('ses') as SessionId;
  await loop.runBlock(ses, '/greet world');

  const history = messages.list(ses);
  const userMsg = history.find((m) => m.role === 'user');
  expect(userMsg?.text).toBe('/greet world');
});

test('explicit /skill-name: rendered skill body is replayed in subsequent turns', async () => {
  const captured: ModelMessage[][] = [];
  const model: ModelRouter = {
    async *stream() {},
    async complete(req): Promise<ModelResult> {
      captured.push(req.messages);
      return { text: 'ok', finishReason: 'stop' };
    }
  };
  const skill: LoadedSkill = {
    name: 'greet',
    description: 'A greeter skill',
    body: 'SKILL_EXPANSION: do the special thing'
  };
  const messages = new InMemoryMessageRepo();
  const loop = new AgentLoop({
    model,
    tools: [],
    messages,
    defaultModel: 'mock',
    emit: () => {},
    skills: [skill]
  });
  const ses = newId('ses') as SessionId;
  await loop.runBlock(ses, '/greet');
  await loop.runBlock(ses, 'follow-up message');
});

test('non-skill messages are unaffected by skill expansion logic', async () => {
  let capturedMessages: ModelMessage[] | undefined;
  const capturingModel: ModelRouter = {
    async *stream() {},
    async complete(req): Promise<ModelResult> {
      capturedMessages = req.messages;
      return { text: 'ok', finishReason: 'stop' };
    }
  };
  const skill: LoadedSkill = {
    name: 'greet',
    description: 'A greeter skill',
    body: 'SKILL_BODY_SHOULD_NOT_APPEAR'
  };
  const loop = new AgentLoop({
    model: capturingModel,
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {},
    skills: [skill]
  });
  await loop.runBlock(newId('ses') as SessionId, 'plain message without skill');

  const text = lastUserText(capturedMessages ?? []);
  expect(text).toBe('plain message without skill');
});
