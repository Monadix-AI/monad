// Tests that session creation enforces agent resolution.
// Uses a temp config file so loadConfig returns a real config (not null).

import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultConfig, saveAll } from '@monad/environment';

import { ModelService } from '#/handlers/settings/model/index.ts';
import { createHttpTransport } from '#/transports/http.ts';
import { buildHandlers, mockModel, seededProviderRegistry } from '../../helpers.ts';

function makeTempPaths() {
  const dir = mkdtempSync(join(tmpdir(), 'monad-session-agent-test-'));
  const paths = {
    home: dir,
    logs: join(dir, 'logs'),
    runtime: dir,
    configs: dir,
    agentsConfig: join(dir, 'agents.json'),
    mesh: join(dir, 'mesh.json'),
    approvals: join(dir, 'approvals.json'),
    dbDir: dir,
    db: join(dir, 'db'),
    config: join(dir, 'config.json'),
    credentials: join(dir, 'credentials'),
    auth: join(dir, 'credentials', 'auth.json'),
    tls: join(dir, 'credentials', 'tls'),
    workspace: dir,
    providers: dir,
    skills: dir,
    skillsLock: join(dir, 'skills.lock'),
    locales: dir,
    mcp: dir,
    atoms: dir,
    packs: join(dir, 'packs'),
    agents: dir,
    memory: dir,
    backup: dir,
    cache: dir,
    bin: join(dir, 'bin'),
    sock: join(dir, 'monad.sock'),
    kvSock: join(dir, 'kv.sock'),
    pid: join(dir, 'monad.pid'),
    version: join(dir, 'monad.version')
  };
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { paths, cleanup };
}

test('POST /v1/sessions without agentId when no agents exist: session created with empty agentIds', async () => {
  // Blank config with no agents, no default — should still succeed (no agents configured means no requirement)
  const { paths, cleanup } = makeTempPaths();
  try {
    const cfg = createDefaultConfig('test');
    await saveAll(paths, cfg);
    const modelService = new ModelService(paths.auth, cfg, null, seededProviderRegistry());
    const app = createHttpTransport(buildHandlers(mockModel(['hi']), { paths, modelService }));
    const res = await app.handle(
      new Request('http://localhost/v1/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'no agents yet' })
      })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { sessionId: string };
    expect(body.sessionId).toMatch(/^ses_/);
  } finally {
    cleanup();
  }
});

test('POST /v1/sessions without agentId when agents exist but no default: 400 error', async () => {
  const { paths, cleanup } = makeTempPaths();
  try {
    const cfg = createDefaultConfig('test');
    // Add an agent but no defaultAgentId
    cfg.agent.agents.push({
      id: 'agt_TEST01000000',
      name: 'My Agent',
      capabilities: [],
      declaredScopes: [],
      atoms: { mode: 'inherit', allow: [], deny: [] },
      visibility: { subagentCallable: false, public: false },
      a2a: { enabled: false },
      monadix: { consume: false }
    });
    await saveAll(paths, cfg);
    const modelService = new ModelService(paths.auth, cfg, null, seededProviderRegistry());
    const app = createHttpTransport(buildHandlers(mockModel(['hi']), { paths, modelService }));
    const res = await app.handle(
      new Request('http://localhost/v1/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'missing default' })
      })
    );
    expect(res.status).toBe(400);
  } finally {
    cleanup();
  }
});

test('POST /v1/sessions without agentId when default is set: resolves agent, agentIds populated', async () => {
  const { paths, cleanup } = makeTempPaths();
  try {
    const cfg = createDefaultConfig('test');
    cfg.agent.agents.push({
      id: 'agt_DEFAULT01000',
      name: 'Default',
      capabilities: [],
      declaredScopes: [],
      atoms: { mode: 'inherit', allow: [], deny: [] },
      visibility: { subagentCallable: false, public: false },
      a2a: { enabled: false },
      monadix: { consume: false }
    });
    cfg.agent.defaultAgentId = 'agt_DEFAULT01000';
    await saveAll(paths, cfg);
    const modelService = new ModelService(paths.auth, cfg, null, seededProviderRegistry());
    const app = createHttpTransport(buildHandlers(mockModel(['hi']), { paths, modelService }));
    const res = await app.handle(
      new Request('http://localhost/v1/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'uses default' })
      })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { sessionId: string };
    expect(body.sessionId).toMatch(/^ses_/);
  } finally {
    cleanup();
  }
});

test('POST /v1/sessions with explicit agentId: resolves correctly', async () => {
  const { paths, cleanup } = makeTempPaths();
  try {
    const cfg = createDefaultConfig('test');
    cfg.agent.agents.push({
      id: 'agt_EXPLICIT0100',
      name: 'Explicit',
      capabilities: [],
      declaredScopes: [],
      atoms: { mode: 'inherit', allow: [], deny: [] },
      visibility: { subagentCallable: false, public: false },
      a2a: { enabled: false },
      monadix: { consume: false }
    });
    await saveAll(paths, cfg);
    const modelService = new ModelService(paths.auth, cfg, null, seededProviderRegistry());
    const app = createHttpTransport(buildHandlers(mockModel(['hi']), { paths, modelService }));
    const res = await app.handle(
      new Request('http://localhost/v1/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'explicit', agentId: 'agt_EXPLICIT0100' })
      })
    );
    expect(res.status).toBe(201);
  } finally {
    cleanup();
  }
});

test('POST /v1/sessions with unknown explicit agentId: 400 error', async () => {
  const { paths, cleanup } = makeTempPaths();
  try {
    const cfg = createDefaultConfig('test');
    cfg.agent.agents.push({
      id: 'agt_REAL01000000',
      name: 'Real',
      capabilities: [],
      declaredScopes: [],
      atoms: { mode: 'inherit', allow: [], deny: [] },
      visibility: { subagentCallable: false, public: false },
      a2a: { enabled: false },
      monadix: { consume: false }
    });
    await saveAll(paths, cfg);
    const modelService = new ModelService(paths.auth, cfg, null, seededProviderRegistry());
    const app = createHttpTransport(buildHandlers(mockModel(['hi']), { paths, modelService }));
    const res = await app.handle(
      new Request('http://localhost/v1/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'bad agent', agentId: 'agt_NOTFOUND0000' })
      })
    );
    expect(res.status).toBe(400);
  } finally {
    cleanup();
  }
});
