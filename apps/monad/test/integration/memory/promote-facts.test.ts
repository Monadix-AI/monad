// MemoryService.promoteFacts: fast-model extraction of durable facts from a span about to be
// compacted away, gated by mode ('suggest' extracts only, 'auto' also writes to the resolved scope).

import type { AgentId } from '@monad/protocol';
import type { ModelResult, ModelRouter } from '#/agent/index.ts';

import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryService } from '#/services/memory/index.ts';
import { createStore } from '#/store/db/index.ts';

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;

function freshStore(agentIds: AgentId[] = ['agt_100000000000' as AgentId]) {
  const store = createStore();
  store.insertSession({
    id: 'ses_100000000000',
    title: 't',
    state: 'active',
    agentIds,
    archived: false,
    restoreCount: 0,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  });
  return store;
}

function routerReturning(text: string): ModelRouter {
  return {
    stream: () => (async function* () {})(),
    async complete(): Promise<ModelResult> {
      return { text };
    }
  };
}

function svc(router: ModelRouter, store = freshStore()) {
  const root = mkdtempSync(join(tmpdir(), 'mem-promote-'));
  return createMemoryService({
    store,
    root,
    dbRoot: root,
    router,
    extractModel: () => 'test',
    backend: () => 'builtin',
    mem0Models: () => ({ models: undefined, llm: null, embedder: null, dim: null }),
    log: silent
  });
}

test('returns null without calling the model for an empty/whitespace transcript', async () => {
  let called = false;
  const router: ModelRouter = {
    stream: () => (async function* () {})(),
    async complete(): Promise<ModelResult> {
      called = true;
      return { text: '[]' };
    }
  };
  const result = await svc(router).promoteFacts('ses_100000000000' as never, '   ', 'suggest');
  expect(result).toBeNull();
  expect(called).toBe(false);
});

test('suggest mode extracts facts and resolves the agent scope, but does not write them', async () => {
  const router = routerReturning('["User prefers dark mode", "Project uses Bun, not Node"]');
  const service = svc(router);
  const result = await service.promoteFacts(
    'ses_100000000000' as never,
    'user: I prefer dark mode\nassistant: noted',
    'suggest'
  );
  expect(result).toEqual({
    scope: { kind: 'agent', id: 'agt_100000000000' },
    facts: ['User prefers dark mode', 'Project uses Bun, not Node']
  });
  const written = await service.listFacts('agent', 'agt_100000000000');
  expect(written).toHaveLength(0); // suggest mode never writes
});

test('auto mode extracts facts AND writes them to the resolved scope', async () => {
  const router = routerReturning('["User prefers dark mode"]');
  const service = svc(router);
  const result = await service.promoteFacts('ses_100000000000' as never, 'some folded span', 'auto');
  expect(result?.facts).toEqual(['User prefers dark mode']);

  const written = await service.listFacts('agent', 'agt_100000000000');
  expect(written.map((f) => f.content)).toEqual(['User prefers dark mode']);
  expect(written[0]?.provClass).toBe('machine');
});

test('auto mode writes ALL extracted facts concurrently, none lost to the read-modify-write append', async () => {
  const router = routerReturning('["User prefers dark mode", "Project uses Bun, not Node", "Deploys on Fridays"]');
  const service = svc(router);
  await service.promoteFacts('ses_100000000000' as never, 'some folded span', 'auto');

  const written = await service.listFacts('agent', 'agt_100000000000');
  // Concurrent Promise.all writes to one scope file — every fact must survive (a racy
  // read-modify-write would drop all but the last).
  expect(written.map((f) => f.content).sort()).toEqual(
    ['Deploys on Fridays', 'Project uses Bun, not Node', 'User prefers dark mode'].sort()
  );
});

test('falls back to the global scope when the session has no agent', async () => {
  const router = routerReturning('["User is a backend engineer"]');
  const service = svc(router, freshStore([]));
  const result = await service.promoteFacts('ses_100000000000' as never, 'some folded span', 'suggest');
  expect(result?.scope).toEqual({ kind: 'global', id: '*' });
});

test('returns null when the model output has no parseable JSON array', async () => {
  const router = routerReturning('sorry, I cannot help with that');
  const result = await svc(router).promoteFacts('ses_100000000000' as never, 'some folded span', 'suggest');
  expect(result).toBeNull();
});

test('returns null when the model produces an empty fact list (nothing durable found)', async () => {
  const router = routerReturning('[]');
  const result = await svc(router).promoteFacts('ses_100000000000' as never, 'some folded span', 'suggest');
  expect(result).toBeNull();
});

test('returns null (not a throw) when the model call itself fails', async () => {
  const router: ModelRouter = {
    stream: () => (async function* () {})(),
    async complete(): Promise<ModelResult> {
      throw new Error('model unavailable');
    }
  };
  const result = await svc(router).promoteFacts('ses_100000000000' as never, 'some folded span', 'suggest');
  expect(result).toBeNull();
});
