import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultConfig, saveAll } from '@monad/environment';

import { createAgentContext } from '#/handlers/settings/agent/context.ts';
import { createAgentHandlers } from '#/handlers/settings/agent/handlers.ts';
import { stubConfigAccess } from '../../helpers.ts';

function makeHandlers() {
  const dir = mkdtempSync(join(tmpdir(), 'monad-agent-test-'));
  const configPath = join(dir, 'config.json');
  const cfg = createDefaultConfig('test');
  // Write initial config synchronously via Bun for simplicity
  const ctx = createAgentContext({
    config: stubConfigAccess(cfg),
    paths: {
      home: dir,
      logs: join(dir, 'logs'),
      runtime: dir,
      configs: dir,
      agentsConfig: join(dir, 'agents.json'),
      mesh: join(dir, 'mesh.json'),
      approvals: join(dir, 'approvals.json'),
      dbDir: dir,
      db: join(dir, 'db'),
      config: configPath,
      credentials: join(dir, 'credentials'),
      auth: join(dir, 'credentials', 'auth.json'),
      tls: join(dir, 'credentials', 'tls'),
      workspace: dir,
      providers: dir,
      skills: dir,
      skillsLock: join(dir, 'skills.lock'),
      locales: '/dev/null',
      mcp: '/dev/null',
      atoms: dir,
      packs: join(dir, 'packs'),
      agents: dir,
      memory: dir,
      backup: dir,
      cache: dir,
      bin: join(dir, 'bin'),
      sock: join(dir, 'monad.sock'),
      kvSock: join(dir, 'kv.sock'),
      pid: join(dir, 'monad.pid')
    }
  });
  return {
    handlers: createAgentHandlers(ctx),
    paths: ctx.paths,
    cfg,
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

test('listAgents: empty on fresh config', async () => {
  const { handlers, cfg, paths, cleanup } = makeHandlers();
  await saveAll(paths, cfg);
  try {
    const result = await handlers.listAgents();
    expect(result.agents).toHaveLength(0);
  } finally {
    cleanup();
  }
});

test('createAgent: generates agt_ id and persists', async () => {
  const { handlers, cfg, paths, cleanup } = makeHandlers();
  await saveAll(paths, cfg);
  try {
    const result = await handlers.createAgent({ name: 'My Agent', capabilities: [] });
    expect(result.agent.id).toMatch(/^agt_/);
    expect(result.agent.name).toBe('My Agent');
    const list = await handlers.listAgents();
    expect(list.agents).toHaveLength(1);
  } finally {
    cleanup();
  }
});

test('getAgent: 404 for unknown id', async () => {
  const { handlers, cfg, paths, cleanup } = makeHandlers();
  await saveAll(paths, cfg);
  try {
    await expect(handlers.getAgent({ agentId: 'agt_UNKNOWN00000' as never })).rejects.toThrow();
  } finally {
    cleanup();
  }
});

test('setDefaultAgent then deleteAgent clears defaultAgentId', async () => {
  const { handlers, cfg, paths, cleanup } = makeHandlers();
  await saveAll(paths, cfg);
  try {
    const { agent } = await handlers.createAgent({ name: 'A', capabilities: [] });
    await handlers.setDefaultAgent({ agentId: agent.id });
    const def = await handlers.getDefaultAgent();
    expect(def.agentId).toBe(agent.id);

    await handlers.deleteAgent({ agentId: agent.id });
    const defAfter = await handlers.getDefaultAgent();
    expect(defAfter.agentId).toBeNull();
  } finally {
    cleanup();
  }
});
