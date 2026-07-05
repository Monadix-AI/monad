import type { MonadPaths } from '@monad/home';

import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createDefaultConfig, emptyAuth, loadAll, loadAuth, saveAll, saveAuth } from '@monad/home';
import { ModelProviderType } from '@monad/protocol';

import {
  applyModelRolesToConfiguredDefaultProfile,
  createSettingsImportModule,
  previewSettingsImport
} from '@/handlers/settings/import/index.ts';
import { ConfigBus } from '@/services/config-bus.ts';

function pathsFor(dir: string): MonadPaths {
  return {
    home: dir,
    logs: join(dir, 'logs'),
    runtime: join(dir, 'runtime'),
    configs: join(dir, 'configs'),
    config: join(dir, 'configs', 'config.json'),
    profile: join(dir, 'configs', 'profile.json'),
    credentials: join(dir, 'credentials'),
    auth: join(dir, 'credentials', 'auth.json'),
    tls: join(dir, 'credentials', 'tls'),
    approvals: join(dir, 'approvals.json'),
    dbDir: join(dir, 'runtime'),
    db: join(dir, 'runtime', 'monad.sqlite'),
    workspace: join(dir, 'workspace'),
    providers: join(dir, 'atoms', 'providers'),
    skills: join(dir, 'atoms', 'skills'),
    skillsLock: join(dir, 'atoms', 'skills.lock'),
    locales: join(dir, 'atoms', 'locales'),
    mcp: join(dir, 'atoms', 'mcp'),
    atoms: join(dir, 'atoms'),
    packs: join(dir, 'atoms', 'packs'),
    agents: join(dir, 'agents'),
    memory: join(dir, 'memory'),
    backup: join(dir, 'backup'),
    cache: join(dir, 'cache'),
    bin: join(dir, 'bin'),
    sock: join(dir, 'runtime', 'monad.sock'),
    kvSock: join(dir, 'runtime', 'kv.sock'),
    pid: join(dir, 'runtime', 'monad.pid')
  };
}

async function makeHome() {
  const dir = await mkdtemp(join(tmpdir(), 'monad-import-test-'));
  const paths = pathsFor(dir);
  await Promise.all([
    mkdir(paths.configs, { recursive: true }),
    mkdir(paths.credentials, { recursive: true }),
    mkdir(paths.skills, { recursive: true }),
    mkdir(paths.agents, { recursive: true })
  ]);
  const cfg = createDefaultConfig('prn_test', 'test');
  cfg.model.default = '';
  cfg.model.providers = [];
  cfg.model.profiles = [];
  await saveAll(paths.config, paths.profile, cfg);
  await saveAuth(paths.auth, emptyAuth());
  return { dir, paths, cfg, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('Codex preview maps model, MCP, sandbox and plugins without exposing secrets', async () => {
  const { dir, cfg, cleanup } = await makeHome();
  const codex = join(dir, 'codex');
  await mkdir(codex, { recursive: true });
  await Bun.write(
    join(codex, 'config.toml'),
    [
      'model = "gpt-4.1"',
      'model_reasoning_effort = "high"',
      'sandbox_mode = "danger-full-access"',
      'approval_policy = "on-request"',
      '[mcp_servers.node_repl]',
      'command = "bun"',
      'args = ["repl.ts"]',
      'startup_timeout_sec = 5',
      '[plugins."browser@openai-bundled"]',
      'enabled = true'
    ].join('\n')
  );
  try {
    const preview = await previewSettingsImport({ from: 'codex', path: codex, replace: false }, cfg);
    expect(preview.items.map((i) => [i.category, i.target, i.action])).toContainEqual([
      'modelProviders',
      'openai',
      'add'
    ]);
    expect(preview.items.map((i) => [i.category, i.target, i.action])).toContainEqual([
      'mcpServers',
      'node_repl',
      'add'
    ]);
    expect(preview.items.find((i) => i.category === 'sandbox')?.risk).toBe('high');
    expect(preview.items.find((i) => i.category === 'plugins')?.action).toBe('manual');
    expect(JSON.stringify(preview)).not.toContain('SECRET');
  } finally {
    await cleanup();
  }
});

test('Codex TOML import handles quoted commas and inline tables', async () => {
  const { dir, paths, cfg, cleanup } = await makeHome();
  const codex = join(dir, 'codex');
  await mkdir(codex, { recursive: true });
  await Bun.write(
    join(codex, 'config.toml'),
    ['[mcp_servers.echo]', 'command = "echo"', 'args = ["hello,world", "ok"]', 'env = { FOO = "bar" }'].join('\n')
  );
  try {
    const mod = createSettingsImportModule({ paths });
    const preview = await previewSettingsImport({ from: 'codex', path: codex, replace: false }, cfg);
    expect(preview.items.map((i) => [i.category, i.target, i.action])).toContainEqual(['mcpServers', 'echo', 'add']);
    await mod.apply({
      from: 'codex',
      path: codex,
      replace: false,
      select: ['mcpServers:echo'],
      allSafe: false,
      hashes: hashesFor(preview.items)
    });
    const saved = await loadAll(paths.config, paths.profile);
    expect(saved?.mcpServers.find((server) => server.name === 'echo')).toMatchObject({
      transport: 'stdio',
      command: 'echo',
      args: ['hello,world', 'ok'],
      env: { FOO: 'bar' }
    });
  } finally {
    await cleanup();
  }
});

test('Codex directory import follows local ~/.codex layout including skills', async () => {
  const { dir, cfg, cleanup } = await makeHome();
  const codex = join(dir, '.codex');
  await mkdir(join(codex, 'skills', 'planner'), { recursive: true });
  await Bun.write(join(codex, 'config.toml'), 'model = "gpt-5.5"\n[mcp_servers.codegraph]\ncommand = "codegraph"\n');
  await Bun.write(
    join(codex, 'skills', 'planner', 'SKILL.md'),
    ['---', 'name: planner', 'description: planning helper', '---', 'Plan carefully.'].join('\n')
  );
  try {
    const preview = await previewSettingsImport({ from: 'auto', path: codex, replace: false }, cfg);
    expect(preview.from).toBe('codex');
    expect(preview.items.map((i) => [i.category, i.target, i.action])).toContainEqual([
      'modelProfiles',
      'codex-gpt-5.5',
      'add'
    ]);
    expect(preview.items.map((i) => [i.category, i.target, i.action])).toContainEqual([
      'mcpServers',
      'codegraph',
      'add'
    ]);
    expect(preview.items.map((i) => [i.category, i.target, i.action])).toContainEqual(['skills', 'planner', 'add']);
  } finally {
    await cleanup();
  }
});

function hashesFor(items: Array<{ id: string; hash: string }>) {
  return Object.fromEntries(items.map((item) => [item.id, item.hash]));
}

test('Claude Code preview maps MCP and subagents but does not import hooks', async () => {
  const { dir, cfg, cleanup } = await makeHome();
  const claude = join(dir, 'claude');
  await mkdir(join(claude, 'agents'), { recursive: true });
  await Bun.write(
    join(claude, 'settings.json'),
    JSON.stringify({
      mcpServers: { fs: { command: 'npx', args: ['@modelcontextprotocol/server-filesystem'] } },
      hooks: { PreToolUse: [{ matcher: 'shell_exec', hooks: [{ command: 'echo ok' }] }] },
      env: { API_KEY: 'SECRET' }
    })
  );
  await Bun.write(
    join(claude, 'agents', 'reviewer.md'),
    ['---', 'name: reviewer', 'description: reviews code', 'tools: Read, Bash', '---', 'Review carefully.'].join('\n')
  );
  try {
    const preview = await previewSettingsImport({ from: 'claude-code', path: claude, replace: false }, cfg);
    expect(preview.items.map((i) => [i.category, i.target, i.action])).toContainEqual(['mcpServers', 'fs', 'add']);
    expect(preview.items.map((i) => [i.category, i.target, i.action])).toContainEqual(['agents', 'reviewer', 'add']);
    expect(preview.items.some((i) => i.category === 'hooks')).toBe(false);
    expect(preview.items.find((i) => i.category === 'credentials')?.action).toBe('manual');
    expect(JSON.stringify(preview)).not.toContain('SECRET');
  } finally {
    await cleanup();
  }
});

test('Claude Code directory import follows local ~/.claude settings without hook or notification import', async () => {
  const { dir, cfg, cleanup } = await makeHome();
  const claude = join(dir, '.claude');
  await mkdir(claude, { recursive: true });
  await Bun.write(
    join(claude, 'settings.json'),
    JSON.stringify({
      agentPushNotifEnabled: false,
      inputNeededNotifEnabled: true,
      hooks: {
        PermissionRequest: [{ matcher: '.*', hooks: [{ type: 'command', command: 'notify-hook' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'pre-hook' }] }]
      },
      env: {}
    })
  );
  try {
    const preview = await previewSettingsImport({ from: 'auto', path: claude, replace: false }, cfg);
    expect(preview.from).toBe('claude-code');
    expect(preview.items.some((i) => i.category === 'hooks')).toBe(false);
    expect(JSON.stringify(preview)).not.toContain('notify-hook');
  } finally {
    await cleanup();
  }
});

test('auto source detection accepts Windows-style path separators', async () => {
  const { dir, cfg, cleanup } = await makeHome();
  const openclaw = join(dir, 'AppData', 'Roaming', 'openclaw');
  await mkdir(openclaw, { recursive: true });
  await Bun.write(
    join(openclaw, 'openclaw.json'),
    JSON.stringify({
      mcp: { servers: { shell: { command: 'cmd', args: ['/c', 'echo', 'ok'] } } }
    })
  );
  try {
    const windowsLikePath = openclaw.split(/[\\/]+/).join('\\');
    const preview = await previewSettingsImport({ from: 'auto', path: windowsLikePath, replace: false }, cfg);
    expect(preview.from).toBe('openclaw');
    expect(preview.items.map((i) => [i.category, i.target, i.action])).toContainEqual(['mcpServers', 'shell', 'add']);
  } finally {
    await cleanup();
  }
});

test('explicit import path expands home shorthand', async () => {
  const { dir, cfg, cleanup } = await makeHome();
  const codex = join(homedir(), `.monad-import-test-${basename(dir)}`);
  await mkdir(codex, { recursive: true });
  await Bun.write(join(codex, 'config.toml'), '[mcp_servers.env_path]\ncommand = "echo"\n');
  try {
    const preview = await previewSettingsImport({ from: 'codex', path: `~/${basename(codex)}`, replace: false }, cfg);
    expect(preview.items.map((i) => [i.category, i.target, i.action])).toContainEqual([
      'mcpServers',
      'env_path',
      'add'
    ]);
  } finally {
    await rm(codex, { recursive: true, force: true });
    await cleanup();
  }
});

test('oversized config file is rejected before parsing', async () => {
  const { dir, cfg, cleanup } = await makeHome();
  const codex = join(dir, 'codex-large');
  await mkdir(codex, { recursive: true });
  await Bun.write(join(codex, 'config.toml'), 'x'.repeat(5 * 1024 * 1024 + 1));
  try {
    await expect(previewSettingsImport({ from: 'codex', path: codex, replace: false }, cfg)).rejects.toThrow(
      'is too large'
    );
  } finally {
    await cleanup();
  }
});

test('Hermes import follows GitHub config.yaml shape for model and mcp_servers', async () => {
  const { dir, cfg, cleanup } = await makeHome();
  const hermes = join(dir, '.hermes');
  await mkdir(hermes, { recursive: true });
  await Bun.write(
    join(hermes, 'config.yaml'),
    [
      'model:',
      '  provider: anthropic',
      '  default: anthropic/claude-sonnet-4-5',
      'mcp_servers:',
      '  filesystem:',
      '    command: npx',
      '    args:',
      '      - "@modelcontextprotocol/server-filesystem"',
      'workflow:',
      '  enabled: true'
    ].join('\n')
  );
  try {
    const preview = await previewSettingsImport({ from: 'auto', path: hermes, replace: false }, cfg);
    expect(preview.from).toBe('hermes');
    expect(preview.items.map((i) => [i.category, i.target, i.action])).toContainEqual([
      'mcpServers',
      'filesystem',
      'add'
    ]);
    expect(preview.items.map((i) => [i.category, i.target, i.action])).toContainEqual([
      'modelProviders',
      'anthropic',
      'add'
    ]);
    expect(preview.items.map((i) => [i.category, i.target, i.action])).toContainEqual([
      'modelProfiles',
      'hermes-claude-sonnet-4-5',
      'add'
    ]);
    expect(preview.items.find((i) => i.target === 'hermes:runtime')?.action).toBe('manual');
  } finally {
    await cleanup();
  }
});

test('OpenClaw import follows GitHub openclaw.json shape with nested mcp.servers', async () => {
  const { dir, cfg, cleanup } = await makeHome();
  const openclaw = join(dir, '.openclaw');
  await mkdir(openclaw, { recursive: true });
  await Bun.write(
    join(openclaw, 'openclaw.json'),
    JSON.stringify({
      model: { provider: 'openai', default: 'gpt-4.1' },
      mcp: {
        servers: {
          playwright: {
            command: 'npx',
            args: ['@playwright/mcp'],
            env: { PLAYWRIGHT_TOKEN: 'SECRET' }
          }
        }
      },
      plugins: [{ id: 'runtime-plugin' }],
      database: { path: './state.db' }
    })
  );
  try {
    const preview = await previewSettingsImport({ from: 'auto', path: openclaw, replace: false }, cfg);
    expect(preview.from).toBe('openclaw');
    expect(preview.items.map((i) => [i.category, i.target, i.action])).toContainEqual([
      'mcpServers',
      'playwright',
      'add'
    ]);
    expect(preview.items.map((i) => [i.category, i.target, i.action])).toContainEqual([
      'modelProviders',
      'openai',
      'add'
    ]);
    expect(preview.items.map((i) => [i.category, i.target, i.action])).toContainEqual([
      'modelProfiles',
      'openclaw-gpt-4.1',
      'add'
    ]);
    expect(preview.items.find((i) => i.target === 'openclaw:runtime')?.action).toBe('manual');
    expect(JSON.stringify(preview)).not.toContain('SECRET');
  } finally {
    await cleanup();
  }
});

test('OpenClaw import accepts array-form mcp.servers without treating runtime state as settings', async () => {
  const { dir, cfg, cleanup } = await makeHome();
  const openclaw = join(dir, '.openclaw');
  await mkdir(openclaw, { recursive: true });
  await Bun.write(
    join(openclaw, 'openclaw.json'),
    JSON.stringify({
      mcp: {
        servers: [
          {
            name: 'memory',
            command: 'mcp-memory',
            args: ['--store', 'state']
          }
        ]
      },
      state: { database: 'openclaw.db' }
    })
  );
  try {
    const preview = await previewSettingsImport({ from: 'openclaw', path: openclaw, replace: false }, cfg);
    expect(preview.items.map((i) => [i.category, i.target, i.action])).toContainEqual(['mcpServers', 'memory', 'add']);
    expect(preview.items.find((i) => i.target === 'openclaw:runtime')?.action).toBe('manual');
  } finally {
    await cleanup();
  }
});

test('fixture corpus covers Codex, Claude Code, Hermes and OpenClaw shapes', async () => {
  const { cfg, cleanup } = await makeHome();
  const fixtures = join(import.meta.dir, '..', 'fixtures', 'settings-import');
  try {
    const cases = [
      { from: 'auto' as const, path: join(fixtures, 'codex'), expected: ['codex', 'fixture_stdio'] },
      { from: 'auto' as const, path: join(fixtures, 'claude'), expected: ['claude-code', 'fixture_fs'] },
      { from: 'auto' as const, path: join(fixtures, 'hermes'), expected: ['hermes', 'fixture_memory'] },
      { from: 'auto' as const, path: join(fixtures, 'openclaw'), expected: ['openclaw', 'fixture_browser'] }
    ] as const;
    for (const c of cases) {
      const preview = await previewSettingsImport({ from: c.from, path: c.path, replace: false }, cfg);
      expect(preview.from).toBe(c.expected[0]);
      expect(preview.items.map((i) => i.target)).toContain(c.expected[1]);
      expect(preview.items.every((i) => typeof i.hash === 'string' && i.hash.length > 0)).toBe(true);
      expect(JSON.stringify(preview)).not.toContain('secret-value');
    }
  } finally {
    await cleanup();
  }
});

test('generic MCP sources import explicit mcpServers configs', async () => {
  const { dir, cfg, cleanup } = await makeHome();
  const cursor = join(dir, 'cursor');
  await mkdir(cursor, { recursive: true });
  await Bun.write(
    join(cursor, 'settings.json'),
    JSON.stringify({
      mcpServers: {
        docs: {
          url: 'https://mcp.example.com/docs',
          headers: { authorization: 'env:DOCS_TOKEN' },
          autoApprove: ['docs.search']
        }
      },
      extensions: [{ id: 'cursor-extension' }]
    })
  );
  try {
    const preview = await previewSettingsImport({ from: 'cursor', path: cursor, replace: false }, cfg);
    expect(preview.from).toBe('cursor');
    expect(preview.items.map((i) => [i.category, i.target, i.action])).toContainEqual(['mcpServers', 'docs', 'add']);
    expect(preview.items.find((i) => i.target === 'cursor:runtime')?.action).toBe('manual');
  } finally {
    await cleanup();
  }
});

test('dry-run preview does not mutate config files', async () => {
  const { dir, paths, cleanup } = await makeHome();
  const codex = join(dir, 'codex');
  await mkdir(codex, { recursive: true });
  await Bun.write(join(codex, 'config.toml'), 'model = "gpt-4.1"\n');
  const beforeConfig = await Bun.file(paths.config).text();
  const beforeProfile = await Bun.file(paths.profile).text();
  try {
    const mod = createSettingsImportModule({ paths });
    await mod.preview({ from: 'codex', path: codex, replace: false });
    expect(await Bun.file(paths.config).text()).toBe(beforeConfig);
    expect(await Bun.file(paths.profile).text()).toBe(beforeProfile);
  } finally {
    await cleanup();
  }
});

test('model role imports target the configured default profile alias', () => {
  const cfg = createDefaultConfig('prn_test', 'test');
  cfg.model.default = 'writer';
  cfg.model.providers = [{ id: 'oai', label: 'OpenAI', type: ModelProviderType.OpenAICompatible }];
  cfg.model.profiles = [
    {
      alias: 'default',
      routes: { chat: { provider: 'oai', modelId: 'gpt-default' } },
      params: {},
      fallbacks: []
    },
    {
      alias: 'writer',
      routes: { chat: { provider: 'oai', modelId: 'gpt-writer' } },
      params: {},
      fallbacks: []
    }
  ];

  applyModelRolesToConfiguredDefaultProfile(cfg, { embedding: 'oai:text-embedding-3-small' });

  expect(cfg.model.profiles.find((profile) => profile.alias === 'writer')?.routes.embedding).toEqual({
    provider: 'oai',
    modelId: 'text-embedding-3-small'
  });
  expect(cfg.model.profiles.find((profile) => profile.alias === 'default')?.routes.embedding).toBeUndefined();
});

test('allSafe applies only low-risk add items', async () => {
  const { dir, paths, cleanup } = await makeHome();
  const codex = join(dir, 'codex');
  await mkdir(codex, { recursive: true });
  await Bun.write(
    join(codex, 'config.toml'),
    [
      'model = "gpt-4.1"',
      'sandbox_mode = "danger-full-access"',
      '[mcp_servers.remote]',
      'url = "https://mcp.example.com/sse"',
      '[mcp_servers.local_shell]',
      'command = "shell-mcp"'
    ].join('\n')
  );
  try {
    const mod = createSettingsImportModule({ paths });
    const preview = await mod.preview({ from: 'codex', path: codex, replace: false });
    const result = await mod.apply({
      from: 'codex',
      path: codex,
      replace: false,
      select: [],
      allSafe: true,
      hashes: hashesFor(preview.items)
    });
    expect(result.applied).toContain('modelProviders:openai');
    expect(result.applied).toContain('modelProfiles:codex-gpt-4.1');
    expect(result.applied).toContain('mcpServers:remote');
    expect(result.applied).not.toContain('mcpServers:local_shell');
    expect(result.applied).not.toContain('sandbox:agent.sandbox.mode');
    const cfg = await loadAll(paths.config, paths.profile);
    expect(cfg?.mcpServers.some((s) => s.name === 'remote')).toBe(true);
    expect(cfg?.mcpServers.some((s) => s.name === 'local_shell')).toBe(false);
    expect(cfg?.agent.sandbox.mode).not.toBe('unrestricted');
  } finally {
    await cleanup();
  }
});

test('replace turns existing MCP conflict into selected update', async () => {
  const { dir, paths, cfg, cleanup } = await makeHome();
  cfg.mcpServers = [
    {
      name: 'echo',
      transport: 'stdio',
      command: 'old-echo',
      enabled: true,
      trust: { autoApproveTools: [], hostEscape: false }
    }
  ];
  await saveAll(paths.config, paths.profile, cfg);
  const codex = join(dir, 'codex');
  await mkdir(codex, { recursive: true });
  await Bun.write(join(codex, 'config.toml'), '[mcp_servers.echo]\ncommand = "new-echo"\n');
  try {
    const mod = createSettingsImportModule({ paths });
    const conflict = await mod.preview({ from: 'codex', path: codex, replace: false });
    expect(conflict.items.find((i) => i.id === 'mcpServers:echo')?.action).toBe('conflict');
    const replacement = await mod.preview({ from: 'codex', path: codex, replace: true });
    expect(replacement.items.find((i) => i.id === 'mcpServers:echo')?.action).toBe('update');
    await mod.apply({
      from: 'codex',
      path: codex,
      replace: true,
      select: ['mcpServers:echo'],
      allSafe: false,
      hashes: hashesFor(replacement.items)
    });
    const after = await loadAll(paths.config, paths.profile);
    const echo = after?.mcpServers.find((s) => s.name === 'echo');
    expect(echo?.transport).toBe('stdio');
    if (echo?.transport === 'stdio') expect(echo.command).toBe('new-echo');
  } finally {
    await cleanup();
  }
});

test('replace updates existing agent instead of adding duplicate', async () => {
  const { dir, paths, cfg, cleanup } = await makeHome();
  cfg.agent.agents = [
    {
      id: 'agt_existing',
      name: 'reviewer',
      dir: 'reviewer',
      description: 'old',
      model: 'old-model',
      framework: undefined,
      capabilities: [],
      declaredScopes: [],
      atoms: { mode: 'inherit', allow: [], deny: [] },
      visibility: { subagentCallable: false, public: false },
      a2a: { enabled: false }
    }
  ];
  await saveAll(paths.config, paths.profile, cfg);
  await Bun.write(join(paths.agents, 'reviewer', 'AGENT.md'), ['<!-- name: reviewer -->', 'Old prompt', ''].join('\n'));
  const claude = join(dir, 'claude');
  await mkdir(join(claude, 'agents'), { recursive: true });
  await Bun.write(
    join(claude, 'agents', 'reviewer.md'),
    ['---', 'name: reviewer', 'description: updated', 'model: claude-3', '---', 'Updated prompt.'].join('\n')
  );
  try {
    const mod = createSettingsImportModule({ paths });
    const replacement = await mod.preview({ from: 'claude-code', path: claude, replace: true });
    expect(replacement.items.find((i) => i.id === 'agents:reviewer')?.action).toBe('update');
    const result = await mod.apply({
      from: 'claude-code',
      path: claude,
      replace: true,
      select: ['agents:reviewer'],
      allSafe: false,
      hashes: hashesFor(replacement.items)
    });
    expect(result.applied).toEqual(['agents:reviewer']);
    const next = await loadAll(paths.config, paths.profile);
    expect(next?.agent.agents).toHaveLength(1);
    const imported = next?.agent.agents[0];
    expect(imported?.id).toBe('agt_existing');
    expect(imported?.description).toBe('updated');
    expect(imported?.model).toBe('claude-3');
    const prompt = await Bun.file(join(paths.agents, 'reviewer', 'AGENT.md')).text();
    expect(prompt).toContain('Updated prompt.');
  } finally {
    await cleanup();
  }
});

test('apply publishes config bus for system-only sandbox updates', async () => {
  const { dir, paths, cleanup } = await makeHome();
  const codex = join(dir, 'codex');
  await mkdir(codex, { recursive: true });
  await Bun.write(join(codex, 'config.toml'), 'sandbox_mode = "danger-full-access"\n');
  const events: Array<'system' | 'profile'> = [];
  const configBus = new ConfigBus();
  configBus.subscribe(() => {
    events.push('system');
  });
  try {
    const mod = createSettingsImportModule({ paths, configBus });
    const preview = await mod.preview({ from: 'codex', path: codex, replace: false });
    await mod.apply({
      from: 'codex',
      path: codex,
      replace: false,
      select: ['sandbox:agent.sandbox.mode'],
      allSafe: false,
      hashes: hashesFor(preview.items)
    });
    expect(events).toEqual(['system']);
    const cfg = await loadAll(paths.config, paths.profile);
    expect(cfg?.agent.sandbox.mode).toBe('unrestricted');
  } finally {
    await cleanup();
  }
});

test('env shorthand expansion in import path works', async () => {
  const { dir, cfg, cleanup } = await makeHome();
  const marker = join(dir, '.monad-import-env');
  await mkdir(marker, { recursive: true });
  await Bun.write(join(marker, 'config.toml'), '[mcp_servers.env_path]\ncommand = "echo"\n');
  const env = process.env as Record<string, string | undefined>;
  const envKey = 'MONAD_IMPORT_ENV_PATH';
  const original = env[envKey];
  env[envKey] = marker;
  try {
    const preview = await previewSettingsImport({ from: 'codex', path: '$MONAD_IMPORT_ENV_PATH', replace: false }, cfg);
    expect(preview.items.map((i) => [i.category, i.target, i.action])).toContainEqual([
      'mcpServers',
      'env_path',
      'add'
    ]);
  } finally {
    if (original === undefined) delete env[envKey];
    else env[envKey] = original;
    await rm(marker, { recursive: true, force: true });
    await cleanup();
  }
});

test('apply skips selected item when preview hash is missing', async () => {
  const { dir, paths, cleanup } = await makeHome();
  const codex = join(dir, 'codex');
  await mkdir(codex, { recursive: true });
  await Bun.write(join(codex, 'config.toml'), '[mcp_servers.echo]\ncommand = "echo"\n');
  try {
    const mod = createSettingsImportModule({ paths });
    const result = await mod.apply({
      from: 'codex',
      path: codex,
      replace: false,
      select: ['mcpServers:echo'],
      allSafe: false,
      hashes: {}
    });
    expect(result.applied).toEqual([]);
    expect(result.skipped).toContainEqual({ id: 'mcpServers:echo', reason: 'missing preview hash for selected item' });
    const cfg = await loadAll(paths.config, paths.profile);
    expect(cfg?.mcpServers).toEqual([]);
  } finally {
    await cleanup();
  }
});

test('selected manual secret-bearing env item is skipped and never writes auth', async () => {
  const { dir, paths, cleanup } = await makeHome();
  const claude = join(dir, 'claude');
  await mkdir(claude, { recursive: true });
  await Bun.write(join(claude, 'settings.json'), JSON.stringify({ env: { API_KEY: 'SECRET' } }));
  try {
    const mod = createSettingsImportModule({ paths });
    const preview = await mod.preview({ from: 'claude-code', path: claude, replace: false });
    const result = await mod.apply({
      from: 'claude-code',
      path: claude,
      replace: false,
      select: ['credentials:env:API_KEY'],
      allSafe: false,
      hashes: hashesFor(preview.items)
    });
    expect(result.applied).toEqual([]);
    expect(result.skipped).toContainEqual({ id: 'credentials:env:API_KEY', reason: 'item action is manual' });
    expect((await loadAuth(paths.auth))?.credentialPool).toEqual({});
    expect(JSON.stringify(result.preview)).not.toContain('SECRET');
  } finally {
    await cleanup();
  }
});

test('apply skips selected item when preview hash changed', async () => {
  const { dir, paths, cleanup } = await makeHome();
  const codex = join(dir, 'codex');
  await mkdir(codex, { recursive: true });
  const config = join(codex, 'config.toml');
  await Bun.write(config, '[mcp_servers.echo]\ncommand = "old-echo"\n');
  try {
    const mod = createSettingsImportModule({ paths });
    const preview = await mod.preview({ from: 'codex', path: codex, replace: false });
    const item = preview.items.find((i) => i.id === 'mcpServers:echo');
    expect(item).toBeDefined();
    await Bun.write(config, '[mcp_servers.echo]\ncommand = "new-echo"\n');
    const result = await mod.apply({
      from: 'codex',
      path: codex,
      replace: false,
      select: ['mcpServers:echo'],
      allSafe: false,
      hashes: { 'mcpServers:echo': item?.hash ?? '' }
    });
    expect(result.applied).toEqual([]);
    expect(result.skipped).toContainEqual({ id: 'mcpServers:echo', reason: 'preview item changed since selection' });
    const cfg = await loadAll(paths.config, paths.profile);
    expect(cfg?.mcpServers).toEqual([]);
  } finally {
    await cleanup();
  }
});

test('apply hash detects changed Claude agent prompt even when public preview fields are unchanged', async () => {
  const { dir, paths, cleanup } = await makeHome();
  const claude = join(dir, 'claude');
  const agentDir = join(claude, 'agents');
  await mkdir(agentDir, { recursive: true });
  const agentFile = join(agentDir, 'reviewer.md');
  const frontmatter = ['---', 'name: reviewer', 'description: reviews code', '---'];
  await Bun.write(agentFile, [...frontmatter, 'Original prompt.'].join('\n'));
  try {
    const mod = createSettingsImportModule({ paths });
    const preview = await mod.preview({ from: 'claude-code', path: claude, replace: false });
    const item = preview.items.find((i) => i.id === 'agents:reviewer');
    expect(item).toBeDefined();
    await Bun.write(agentFile, [...frontmatter, 'Changed prompt.'].join('\n'));
    const result = await mod.apply({
      from: 'claude-code',
      path: claude,
      replace: false,
      select: ['agents:reviewer'],
      allSafe: false,
      hashes: { 'agents:reviewer': item?.hash ?? '' }
    });
    expect(result.applied).toEqual([]);
    expect(result.skipped).toContainEqual({ id: 'agents:reviewer', reason: 'preview item changed since selection' });
  } finally {
    await cleanup();
  }
});

test('apply selected imports MCP, model profile and skill', async () => {
  const { dir, paths, cleanup } = await makeHome();
  const codex = join(dir, 'codex');
  await mkdir(join(codex, 'skills', 'hello'), { recursive: true });
  await Bun.write(
    join(codex, 'config.toml'),
    ['model = "gpt-4.1"', '[mcp_servers.echo]', 'command = "echo"', 'args = ["hi"]'].join('\n')
  );
  await Bun.write(
    join(codex, 'skills', 'hello', 'SKILL.md'),
    ['---', 'name: hello', 'description: hello', '---', 'Say hello.'].join('\n')
  );
  try {
    const mod = createSettingsImportModule({ paths });
    const preview = await mod.preview({ from: 'codex', path: codex, replace: false });
    const ids = preview.items.filter((i) => i.action === 'add').map((i) => i.id);
    const result = await mod.apply({
      from: 'codex',
      path: codex,
      replace: false,
      select: ids,
      allSafe: false,
      hashes: hashesFor(preview.items)
    });
    expect(result.applied.sort()).toEqual(ids.sort());
    const cfg = await loadAll(paths.config, paths.profile);
    expect(cfg?.mcpServers.some((s) => s.name === 'echo')).toBe(true);
    expect(cfg?.model.default).toBe('default');
    expect(cfg?.model.profiles.find((profile) => profile.alias === 'default')).toMatchObject({
      routes: { chat: { provider: 'openai', modelId: 'gpt-4.1' } }
    });
    expect(await Bun.file(join(paths.skills, 'hello', 'SKILL.md')).exists()).toBe(true);
    expect((await loadAuth(paths.auth))?.credentialPool).toEqual({});
  } finally {
    await cleanup();
  }
});

test('skill import skips directories above the import size limit', async () => {
  const { dir, paths, cleanup } = await makeHome();
  const codex = join(dir, 'codex');
  const skill = join(codex, 'skills', 'heavy');
  await mkdir(skill, { recursive: true });
  await Bun.write(join(codex, 'config.toml'), '');
  await Bun.write(
    join(skill, 'SKILL.md'),
    ['---', 'name: heavy', 'description: heavy skill', '---', 'Heavy.'].join('\n')
  );
  await Bun.write(join(skill, 'blob.bin'), 'x'.repeat(10 * 1024 * 1024 + 1));
  try {
    const mod = createSettingsImportModule({ paths });
    const preview = await mod.preview({ from: 'codex', path: codex, replace: false });
    const item = preview.items.find((i) => i.id === 'skills:heavy');
    expect(item).toBeDefined();
    const result = await mod.apply({
      from: 'codex',
      path: codex,
      replace: false,
      select: ['skills:heavy'],
      allSafe: false,
      hashes: { 'skills:heavy': item?.hash ?? '' }
    });
    expect(result.applied).toEqual([]);
    expect(result.skipped[0]?.reason).toContain('skill import is too large');
    expect(await Bun.file(join(paths.skills, 'heavy', 'SKILL.md')).exists()).toBe(false);
  } finally {
    await cleanup();
  }
});
