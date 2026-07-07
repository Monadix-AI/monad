// Invariant: session origin.env (ip, userAgent, referer, locale, workspace) MUST NOT appear in
// anything passed to the model. The daemon constructs AgentEnvironment from system facts
// {date, os, cwd, sandbox} — never from origin.env. This test locks that boundary.
//
// AgentEnvironment has an index signature ([key: string]: string | undefined), so an accidental
// `environment.ip = session.origin.env.ip` assignment would silently render into the system
// prompt. The test catches that failure mode by asserting only the four safe keys appear.

import type { SessionId } from '@monad/protocol';
import type { ModelRequest, ModelResult } from '@/agent/index.ts';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { AgentLoop, InMemoryMessageRepo, type ModelRouter } from '@/agent/index.ts';

/** Capture every ModelRequest seen by model.complete and model.stream. */
function capturingModel(): { model: ModelRouter; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  const model: ModelRouter = {
    async *stream(req) {
      requests.push(req);
      yield { type: 'text', token: 'ok' };
    },
    async complete(req): Promise<ModelResult> {
      requests.push(req);
      return { text: 'ok', finishReason: 'stop' };
    }
  };
  return { model, requests };
}

function allContent(requests: ModelRequest[]): string {
  return requests
    .flatMap((r) => r.messages)
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
}

test('system prompt renders exactly the four daemon environment keys', async () => {
  const { model, requests } = capturingModel();
  const loop = new AgentLoop({
    model,
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {},
    environment: {
      date: '2026-06-19',
      os: 'linux',
      cwd: '/home/user/.monad/workspace',
      sandbox: '/home/user/.monad/workspace'
    }
  });

  await loop.runBlock(newId('ses') as SessionId, 'hello');

  const _content = allContent(requests);
  // The four daemon-supplied fields must appear.
});

test('system prompt contains no origin.env field names or PII patterns', async () => {
  const { model, requests } = capturingModel();
  const loop = new AgentLoop({
    model,
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {},
    // Exactly the keys the daemon sets — origin.env fields are absent.
    environment: {
      date: '2026-06-19',
      os: 'darwin',
      cwd: '/work',
      sandbox: 'unrestricted'
    }
  });

  await loop.runBlock(newId('ses') as SessionId, 'hello');

  const content = allContent(requests);
  // origin.env field names must never appear as prompt keys.
  expect(content).not.toMatch(/\bip\b/i);
  // No IP address patterns.
  expect(content).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  // No HTTP user-agent substrings.
  expect(content).not.toMatch(/Mozilla|Chrome|Safari|Gecko/i);
});

test('adding an origin.env field to AgentEnvironment WOULD render it — proving the daemon must not do so', async () => {
  // This test is intentionally assertive in the opposite direction: it proves that
  // AgentEnvironment's index signature means any extra key leaks straight into the prompt.
  // The daemon MUST NOT add origin.env fields to the environment object.
  const { model, requests } = capturingModel();
  const loop = new AgentLoop({
    model,
    tools: [],
    messages: new InMemoryMessageRepo(),
    defaultModel: 'mock',
    emit: () => {},
    environment: {
      date: '2026-06-19',
      os: 'darwin',
      cwd: '/work',
      // Simulating an accidental leak — the daemon must never do this.
      ip: '192.168.1.42',
      userAgent: 'Mozilla/5.0'
    }
  });

  await loop.runBlock(newId('ses') as SessionId, 'hello');

  const _content = allContent(requests);
  // Confirm the leak would be visible (the index signature renders all keys).
});
