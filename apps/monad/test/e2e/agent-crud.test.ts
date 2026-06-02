// e2e: the Studio agent CRUD REST surface over a real temp ~/.monad, exercised over BOTH transports
// (TCP loopback + Unix socket). Asserts the full lifecycle (create → get → prompt get/set → update →
// delete) persists to profile.json AND that the AGENT.md body lands on disk under <agents>/<dir>/.

import type { MonadPaths } from '@monad/home';
import type { Agent } from '@monad/protocol';

import { describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initMonadHome, loadAll, loadAuth, loadConfig } from '@monad/home';

import { ModelService } from '@/handlers/settings/model/index.ts';
import { createHttpTransport } from '@/transports/http.ts';
import {
  buildHandlers,
  makeTestPaths,
  mockModel,
  seededProviderRegistry,
  serveTransport,
  TRANSPORTS,
  type TransportHandle
} from '../helpers.ts';

function makePaths(base: string): MonadPaths {
  return makeTestPaths(base);
}

async function setup(): Promise<{ dir: string; paths: MonadPaths; app: ReturnType<typeof createHttpTransport> }> {
  const dir = join(tmpdir(), `monad-agentcrud-${process.pid}-${Date.now()}-${process.hrtime.bigint()}`);
  const paths = makePaths(dir);
  await initMonadHome(paths);
  const cfg = await loadConfig(paths.config);
  if (!cfg) throw new Error('config missing after init');
  const modelService = new ModelService(paths.auth, cfg, await loadAuth(paths.auth), seededProviderRegistry());
  const app = createHttpTransport(buildHandlers(mockModel(), { paths, modelService }));
  return { dir, paths, app };
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body)
});

interface AgentBody {
  agent: Agent;
}
interface ListBody {
  agents: Agent[];
}
interface PromptBody {
  prompt: string;
}

async function runCrud(t: TransportHandle, paths: MonadPaths): Promise<void> {
  // 1. empty roster to start
  let res = await t.fetch('/v1/agents');
  expect(res.status).toBe(200);
  expect(((await res.json()) as ListBody).agents).toEqual([]);

  // 2. create with a persona body + atoms allowlist + per-agent sandbox + visibility
  res = await t.fetch(
    '/v1/agents',
    json('POST', {
      name: 'Researcher',
      description: 'use for deep research',
      atoms: { mode: 'allowlist', allow: ['web'], deny: [] },
      sandboxMode: 'workspace',
      visibility: { subagentCallable: true, public: false },
      prompt: 'You are a careful researcher.'
    })
  );
  expect(res.status).toBe(201);
  const created = ((await res.json()) as AgentBody).agent;
  expect(created.name).toBe('Researcher');
  expect(created.hasPrompt).toBe(true);
  expect(created.atoms?.allow).toEqual(['web']);
  expect(created.sandboxMode).toBe('workspace');
  expect(created.visibility?.subagentCallable).toBe(true);
  const id = created.id;

  // 3. get by id reflects the same view
  res = await t.fetch(`/v1/agents/${id}`);
  expect(res.status).toBe(200);
  expect(((await res.json()) as AgentBody).agent.description).toBe('use for deep research');

  // 4. prompt get returns the body written at create
  res = await t.fetch(`/v1/agents/${id}/prompt`);
  expect(((await res.json()) as PromptBody).prompt).toBe('You are a careful researcher.');

  // 5. prompt set overwrites; get reflects it
  res = await t.fetch(`/v1/agents/${id}/prompt`, json('PUT', { prompt: 'You are a meticulous researcher.' }));
  expect(res.status).toBe(200);
  res = await t.fetch(`/v1/agents/${id}/prompt`);
  expect(((await res.json()) as PromptBody).prompt).toBe('You are a meticulous researcher.');

  // 6. update a subset of fields → only those change
  res = await t.fetch(
    `/v1/agents/${id}`,
    json('PATCH', { description: 'now a writer', visibility: { subagentCallable: false, public: false } })
  );
  expect(res.status).toBe(200);
  const updated = ((await res.json()) as AgentBody).agent;
  expect(updated.description).toBe('now a writer');
  expect(updated.visibility?.subagentCallable).toBe(false);
  expect(updated.name).toBe('Researcher'); // untouched

  // 6b. per-agent model-role override round-trips (the `memory` role uses a cheaper model here)
  res = await t.fetch(`/v1/agents/${id}`, json('PATCH', { roles: { memory: 'cheap-alias' } }));
  expect(res.status).toBe(200);
  expect(((await res.json()) as AgentBody).agent.roles?.memory).toBe('cheap-alias');

  // 7. AGENT.md persisted on disk under <agents>/<dir>/ and profile.json carries the row
  const cfg = await loadAll(paths.config, paths.profile);
  const row = cfg?.agent.agents.find((a) => a.id === id);
  expect(row?.dir).toBeTruthy();
  const md = await Bun.file(join(paths.agents, row?.dir as string, 'AGENT.md')).text();
  expect(md).toContain('You are a meticulous researcher.');

  // 8. delete → gone from list, profile.json, and disk
  res = await t.fetch(`/v1/agents/${id}`, json('DELETE'));
  expect(res.status).toBe(200);
  res = await t.fetch('/v1/agents');
  expect(((await res.json()) as ListBody).agents).toEqual([]);
  expect((await loadAll(paths.config, paths.profile))?.agent.agents).toEqual([]);
  expect(await Bun.file(join(paths.agents, row?.dir as string, 'AGENT.md')).exists()).toBe(false);
}

for (const kind of TRANSPORTS) {
  describe(`agent CRUD over ${kind}`, () => {
    test('full lifecycle persists to profile.json + AGENT.md on disk', async () => {
      const { dir, paths, app } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runCrud(t, paths);
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
}
