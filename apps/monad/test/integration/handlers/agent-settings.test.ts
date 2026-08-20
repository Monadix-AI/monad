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
  const config = stubConfigAccess(cfg);
  // Write initial config synchronously via Bun for simplicity
  const ctx = createAgentContext({
    config,
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
    config,
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
  const { handlers, cfg, config, paths, cleanup } = makeHandlers();
  await saveAll(paths, cfg);
  try {
    const result = await handlers.createAgent({
      name: 'My Agent',
      capabilities: [],
      credentialIds: [],
      memory: { enabled: true, advanced: true, autoConsolidate: false, intervalMinutes: 30 }
    });
    expect(result.agent.id).toMatch(/^agt_/);
    expect(result.agent).toMatchObject({
      name: 'My Agent',
      memory: { enabled: true, advanced: true, autoConsolidate: false, intervalMinutes: 30 }
    });
    const updated = await handlers.updateAgent({
      agentId: result.agent.id,
      memory: { enabled: false, advanced: true, autoConsolidate: false, intervalMinutes: 30 }
    });
    expect(updated.agent.memory).toEqual({
      enabled: false,
      advanced: true,
      autoConsolidate: false,
      intervalMinutes: 30
    });
    expect(config.get().cfg.agent.agents[0]?.memory).toEqual({
      enabled: false,
      advanced: true,
      autoConsolidate: false,
      intervalMinutes: 30
    });
    const list = await handlers.listAgents();
    expect(list.agents).toHaveLength(1);
  } finally {
    cleanup();
  }
});

test('agent settings round-trip the stable directory and per-agent skill switches', async () => {
  const { handlers, cfg, paths, cleanup } = makeHandlers();
  await saveAll(paths, cfg);
  try {
    const { agent } = await handlers.createAgent({
      name: 'Private Researcher',
      capabilities: [],
      credentialIds: [],
      memory: { enabled: true, advanced: true, autoConsolidate: false, intervalMinutes: 30 },
      skills: { mode: 'inherit', allow: [], autoload: false, disabled: ['global:pdf'] }
    });

    expect(agent.dir).toBe('private-researcher');
    expect(agent.skills).toEqual({ mode: 'inherit', allow: [], autoload: false, disabled: ['global:pdf'] });

    const updated = await handlers.updateAgent({
      agentId: agent.id,
      skills: {
        mode: 'allowlist',
        allow: ['atom-pack:writing:review'],
        autoload: true,
        disabled: []
      }
    });
    expect(updated.agent).toEqual({
      ...agent,
      skills: {
        mode: 'allowlist',
        allow: ['atom-pack:writing:review'],
        autoload: true,
        disabled: []
      }
    });
  } finally {
    cleanup();
  }
});

test('installAgentMcp writes a server only beneath the selected Agent directory', async () => {
  const { handlers, cfg, paths, cleanup } = makeHandlers();
  await saveAll(paths, cfg);
  try {
    const { agent } = await handlers.createAgent({
      name: 'Private Researcher',
      capabilities: [],
      credentialIds: [],
      memory: { enabled: true, advanced: true, autoConsolidate: false, intervalMinutes: 30 }
    });
    const result = await handlers.installAgentMcp({
      agentId: agent.id,
      consent: true,
      server: {
        name: 'local-search',
        transport: 'stdio',
        command: 'bunx',
        args: ['local-search'],
        enabled: true,
        trust: { autoApproveTools: [], hostEscape: false }
      }
    });

    expect(result).toEqual({
      name: 'local-search',
      warnings: ['runs `bunx local-search` on your machine when the agent uses it']
    });
    expect(
      JSON.parse(await Bun.file(join(paths.agents, 'private-researcher', 'mcp', 'local-search.json')).text())
    ).toEqual({
      mcpServers: {
        'local-search': {
          command: 'bunx',
          args: ['local-search'],
          trust: { autoApproveTools: [] }
        }
      }
    });
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
    const { agent } = await handlers.createAgent({
      name: 'A',
      capabilities: [],
      credentialIds: [],
      memory: { enabled: true, advanced: true, autoConsolidate: false, intervalMinutes: 30 }
    });
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

test('agent prompt slots round-trip AGENT.md and USER.md', async () => {
  const { handlers, cfg, paths, cleanup } = makeHandlers();
  await saveAll(paths, cfg);
  try {
    const { agent } = await handlers.createAgent({
      name: 'Researcher',
      capabilities: [],
      credentialIds: [],
      memory: { enabled: true, advanced: true, autoConsolidate: false, intervalMinutes: 30 },
      prompt: 'Legacy agent body'
    });

    expect(await handlers.getAgentPrompt({ agentId: agent.id })).toEqual({
      prompt: 'Legacy agent body',
      slots: { agent: 'Legacy agent body', user: '' }
    });

    expect(
      await handlers.setAgentPrompt({
        agentId: agent.id,
        slots: {
          agent: 'Review code.',
          user: 'Prefers concise answers.'
        }
      })
    ).toEqual({
      prompt: 'Review code.',
      slots: {
        agent: 'Review code.',
        user: 'Prefers concise answers.'
      }
    });

    expect(await handlers.getAgentPrompt({ agentId: agent.id })).toEqual({
      prompt: 'Review code.',
      slots: {
        agent: 'Review code.',
        user: 'Prefers concise answers.'
      }
    });
  } finally {
    cleanup();
  }
});
