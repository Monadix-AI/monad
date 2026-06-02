// e2e: the acp-agent-settings REST surface over a real temp ~/.monad, exercised over BOTH transports
// (TCP loopback + Unix socket). Asserts CRUD works and persists to config.json (acpAgents is SYSTEM
// config, unlike channels which live in profile.json).

import type { MonadPaths } from '@monad/home';

import { describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envRef, initMonadHome, loadAll, loadAuth, loadConfig } from '@monad/home';

import { ModelService } from '@/handlers/settings/model/index.ts';
import { createHttpTransport } from '@/transports/http.ts';
import {
  buildHandlers,
  makeTestPaths,
  mockModel,
  seededProviderRegistry,
  serveTransport,
  TRANSPORTS
} from '../helpers.ts';

function makePaths(base: string): MonadPaths {
  return makeTestPaths(base);
}

function agentView() {
  return { name: 'codex', command: 'codex', args: ['acp'], env: { TOK: envRef('TOK') }, enabled: true };
}

type Call = (method: string, path: string, body?: unknown) => Promise<Response>;
interface AgentsBody {
  agents: { name: string; command: string; enabled: boolean; args?: string[]; env?: Record<string, string> }[];
}

async function runAcpAgentCrud(call: Call, paths: MonadPaths): Promise<void> {
  // 1. empty to start
  let res = await call('GET', '/v1/settings/acp-agents');
  expect(res.status).toBe(200);
  expect(((await res.json()) as AgentsBody).agents).toEqual([]);

  // 2. upsert
  res = await call('PUT', '/v1/settings/acp-agents', { agent: agentView() });
  expect(res.status).toBe(200);

  // 3. lists back with the full spec (env refs included)
  res = await call('GET', '/v1/settings/acp-agents');
  const { agents } = (await res.json()) as AgentsBody;
  expect(agents.length).toBe(1);
  expect(agents[0]?.name).toBe('codex');
  expect(agents[0]?.args).toEqual(['acp']);
  expect(agents[0]?.env?.TOK).toBe(envRef('TOK'));

  // 4. persisted to config.json (SYSTEM config), not profile.json
  const sys = await loadConfig(paths.config);
  expect(sys?.acpAgents.find((a) => a.name === 'codex')).toBeDefined();
  const merged = await loadAll(paths.config, paths.profile);
  expect(merged?.acpAgents.length).toBe(1);

  // 5. disable → reflected
  res = await call('POST', '/v1/settings/acp-agents/codex/disable');
  expect(res.status).toBe(200);
  res = await call('GET', '/v1/settings/acp-agents');
  expect(((await res.json()) as AgentsBody).agents[0]?.enabled).toBe(false);

  // 6. re-enable → back to enabled
  res = await call('POST', '/v1/settings/acp-agents/codex/enable');
  expect(res.status).toBe(200);
  res = await call('GET', '/v1/settings/acp-agents');
  expect(((await res.json()) as AgentsBody).agents[0]?.enabled).toBe(true);

  // 7. remove → gone from list AND config.json
  res = await call('DELETE', '/v1/settings/acp-agents/codex');
  expect(res.status).toBe(200);
  res = await call('GET', '/v1/settings/acp-agents');
  expect(((await res.json()) as AgentsBody).agents).toEqual([]);
  expect((await loadConfig(paths.config))?.acpAgents).toEqual([]);
}

async function runAcpAgentOverwrite(call: Call): Promise<void> {
  // upsert the same name twice with different config → second wins
  await call('PUT', '/v1/settings/acp-agents', { agent: agentView() });
  const updated = { ...agentView(), args: ['acp', '--verbose'], env: {} };
  const res = await call('PUT', '/v1/settings/acp-agents', { agent: updated });
  expect(res.status).toBe(200);

  const { agents } = (await (await call('GET', '/v1/settings/acp-agents')).json()) as AgentsBody;
  expect(agents.length).toBe(1);
  expect(agents[0]?.args).toEqual(['acp', '--verbose']);
  expect(agents[0]?.env).toEqual({});

  await call('DELETE', '/v1/settings/acp-agents/codex');
}

async function runAcpAgentMulti(call: Call, paths: MonadPaths): Promise<void> {
  const second = { name: 'claude-code', command: 'claude', args: [], env: {}, enabled: true };

  await call('PUT', '/v1/settings/acp-agents', { agent: agentView() });
  await call('PUT', '/v1/settings/acp-agents', { agent: second });

  let res = await call('GET', '/v1/settings/acp-agents');
  let { agents } = (await res.json()) as AgentsBody;
  expect(agents.length).toBe(2);
  expect(agents.map((a) => a.name).sort()).toEqual(['claude-code', 'codex']);

  // both persisted to config.json
  const cfg = await loadConfig(paths.config);
  expect(cfg?.acpAgents.length).toBe(2);

  // removing one leaves the other intact
  await call('DELETE', '/v1/settings/acp-agents/codex');
  res = await call('GET', '/v1/settings/acp-agents');
  ({ agents } = (await res.json()) as AgentsBody);
  expect(agents.length).toBe(1);
  expect(agents[0]?.name).toBe('claude-code');

  await call('DELETE', '/v1/settings/acp-agents/claude-code');
}

interface PresetsBody {
  presets: {
    id: string;
    label: string;
    command: string;
    args: string[];
    installed: boolean;
    resolvedBinPath?: string;
  }[];
}

async function runAcpAgentPresets(call: Call): Promise<void> {
  const res = await call('GET', '/v1/settings/acp-agents/presets');
  expect(res.status).toBe(200);
  const { presets } = (await res.json()) as PresetsBody;
  // The static path must not be shadowed by /:name, and the two invite presets must come back.
  expect(presets.map((p) => p.id).sort()).toEqual(['claude-code', 'codex']);
  for (const p of presets) {
    expect(p.command).toBe('npx'); // self-contained ACP adapters via npx
    expect(typeof p.installed).toBe('boolean'); // same-machine detection ran
  }
}

async function runAcpAgentValidation(call: Call, paths: MonadPaths): Promise<void> {
  // A whitespace-only command passes the wire schema's min(1) but must be rejected by the handler.
  const res = await call('PUT', '/v1/settings/acp-agents', {
    agent: { name: 'blank', command: '   ', args: [], enabled: true }
  });
  expect(res.status).not.toBe(200);
  // …and nothing was persisted.
  expect((await loadConfig(paths.config))?.acpAgents.find((a) => a.name === 'blank')).toBeUndefined();
}

async function setup(): Promise<{ dir: string; paths: MonadPaths; app: ReturnType<typeof createHttpTransport> }> {
  const dir = join(tmpdir(), `monad-acpsettings-${process.pid}-${Date.now()}-${process.hrtime.bigint()}`);
  const paths = makePaths(dir);
  await initMonadHome(paths);
  const cfg = await loadConfig(paths.config);
  if (!cfg) throw new Error('config missing after init');
  const modelService = new ModelService(paths.auth, cfg, await loadAuth(paths.auth), seededProviderRegistry());
  const app = createHttpTransport(buildHandlers(mockModel(), { paths, modelService }));
  return { dir, paths, app };
}

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body)
});

for (const kind of TRANSPORTS) {
  describe(`acp-agent-settings over ${kind}`, () => {
    test('CRUD + enable/disable persists to config.json', async () => {
      const { dir, paths, app } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runAcpAgentCrud((m, p, b) => t.fetch(p, jsonInit(m, b)), paths);
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('upsert same name overwrites previous entry', async () => {
      const { dir, paths: _paths, app } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runAcpAgentOverwrite((m, p, b) => t.fetch(p, jsonInit(m, b)));
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('multiple agents list and delete independently', async () => {
      const { dir, paths, app } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runAcpAgentMulti((m, p, b) => t.fetch(p, jsonInit(m, b)), paths);
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('invite presets list with same-machine detection', async () => {
      const { dir, app } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runAcpAgentPresets((m, p, b) => t.fetch(p, jsonInit(m, b)));
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('rejects an upsert with a blank command', async () => {
      const { dir, paths, app } = await setup();
      const t = serveTransport(kind, app);
      try {
        await runAcpAgentValidation((m, p, b) => t.fetch(p, jsonInit(m, b)), paths);
      } finally {
        await t.stop();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
}
