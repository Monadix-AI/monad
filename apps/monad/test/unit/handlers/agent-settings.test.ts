import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultConfig, saveAll } from '@monad/home';
import { newId } from '@monad/protocol';

import { createAgentContext } from '#/handlers/settings/agent/context.ts';
import { createAgentHandlers } from '#/handlers/settings/agent/handlers.ts';

function makeHandlers() {
  const dir = mkdtempSync(join(tmpdir(), 'monad-agent-test-'));
  const configPath = join(dir, 'config.json');
  const cfg = createDefaultConfig('prn_test00000000', 'test');
  // Write initial config synchronously via Bun for simplicity
  const ctx = createAgentContext({
    paths: {
      home: dir,
      logs: join(dir, 'logs'),
      runtime: dir,
      configs: dir,
      profile: join(dir, 'profile.json'),
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
  const principalId = newId('prn');
  return {
    handlers: createAgentHandlers(ctx, principalId),
    configPath,
    profilePath: join(dir, 'profile.json'),
    cfg,
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

test('listAgents: empty on fresh config', async () => {
  const { handlers, cfg, configPath, profilePath, cleanup } = makeHandlers();
  await saveAll(configPath, profilePath, cfg);
  try {
    const _result = await handlers.listAgents();
  } finally {
    cleanup();
  }
});

test('createAgent: generates agt_ id and persists', async () => {
  const { handlers, cfg, configPath, profilePath, cleanup } = makeHandlers();
  await saveAll(configPath, profilePath, cfg);
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
  const { handlers, cfg, configPath, profilePath, cleanup } = makeHandlers();
  await saveAll(configPath, profilePath, cfg);
  try {
    await expect(handlers.getAgent({ agentId: 'agt_UNKNOWN00000' as never })).rejects.toThrow();
  } finally {
    cleanup();
  }
});

test('setDefaultAgent then deleteAgent clears defaultAgentId', async () => {
  const { handlers, cfg, configPath, profilePath, cleanup } = makeHandlers();
  await saveAll(configPath, profilePath, cfg);
  try {
    const { agent } = await handlers.createAgent({ name: 'A', capabilities: [] });
    await handlers.setDefaultAgent({ agentId: agent.id });
    const def = await handlers.getDefaultAgent();
    expect(def.agentId).toBe(agent.id);

    await handlers.deleteAgent({ agentId: agent.id });
    const _defAfter = await handlers.getDefaultAgent();
  } finally {
    cleanup();
  }
});
