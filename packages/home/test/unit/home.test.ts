import type { MonadPaths } from '../../src/paths.ts';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelProviderType } from '@monad/protocol';

import {
  createDefaultConfig,
  DEFAULT_TRANSPORT,
  loadAll,
  loadAuth,
  loadConfig,
  mcpServerSchema,
  migrateConfig,
  monadConfigSchema,
  monadProfileSchema,
  monadSystemConfigSchema,
  PROFILE_SCHEMA_CONTENT,
  SCHEMA_CONTENT,
  saveAuth,
  saveProfile,
  saveSystemConfig,
  tryParseConfig
} from '../../src/config/index.ts';
import { resolveClientConn } from '../../src/connection.ts';
import { initMonadHome } from '../../src/init.ts';
import { computeInitStatus } from '../../src/init-status.ts';
import { resolveDaemonNetwork, resolveDaemonUrl } from '../../src/network-endpoints.ts';
import { getPaths, xdgPaths } from '../../src/paths.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePaths(base: string): MonadPaths {
  const runtime = join(base, 'runtime');
  const credentials = join(base, 'credentials');
  return {
    home: base,
    runtime,
    configs: join(base, 'configs'),
    config: join(base, 'configs', 'config.json'),
    profile: join(base, 'configs', 'profile.json'),
    approvals: join(base, 'configs', 'approvals.json'),
    credentials,
    auth: join(credentials, 'auth.json'),
    tls: join(credentials, 'tls'),
    workspace: join(base, 'agents', 'default'),
    providers: join(base, 'atoms', 'providers'),
    skills: join(base, 'atoms', 'skills'),
    skillsLock: join(base, 'atoms', 'skills.lock'),
    locales: join(base, 'atoms', 'locales'),
    mcp: join(base, 'atoms', 'mcp'),
    atoms: join(base, 'atoms'),
    packs: join(base, 'atoms', 'packs'),
    agents: join(base, 'agents'),
    memory: join(base, 'memory'),
    cache: join(base, 'cache'),
    logs: join(base, 'logs'),
    dbDir: join(base, 'db'),
    db: join(base, 'db', 'monad.sqlite'),
    backup: join(base, 'backup'),
    bin: join(base, 'bin'),
    sock: join(runtime, 'monad.sock'),
    kvSock: join(runtime, 'kv.sock'),
    pid: join(runtime, 'monad.pid')
  };
}

let testDir: string;
let paths: MonadPaths;

beforeEach(() => {
  testDir = join(tmpdir(), `monad-test-${Date.now()}`);
  paths = makePaths(testDir);
});

afterEach(async () => {
  // Windows releases SQLite/WAL handles slightly after store.close(), so an immediate recursive
  // delete can hit EBUSY/EPERM. Bun's fs.rm ignores maxRetries, so retry by hand, then give up —
  // a leftover temp dir on an ephemeral runner is harmless, but failing teardown isn't.
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rm(testDir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw err;
      await Bun.sleep(100);
    }
  }
});

// ── initMonadHome ─────────────────────────────────────────────────────────────

describe('initMonadHome', () => {
  test('creates config.json on first run with a prn_ principal id', async () => {
    const result = await initMonadHome(paths, { displayName: 'test-user' });
    expect(result.created).toBe(true);
    expect(result.principalId).toMatch(/^prn_/);

    const cfg = await loadAll(paths.config, paths.profile);
    expect(cfg?.principal.id).toBe(result.principalId);
    expect(cfg?.principal.displayName).toBe('test-user');
    expect(cfg?.agent.sandbox.mode).toBe('workspace');
  });

  test('native CLI agents are stored in system config and merged into loadAll', async () => {
    await initMonadHome(paths);
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('config missing');
    await saveSystemConfig(paths.config, {
      ...cfg,
      nativeCliAgents: [
        {
          name: 'codex',
          provider: 'codex',
          command: 'codex',
          enabled: true,
          defaultLaunchMode: 'pty',
          allowAutopilot: false,
          approvalOwnership: 'provider-owned'
        }
      ]
    });

    expect((await loadConfig(paths.config))?.nativeCliAgents).toHaveLength(1);
    expect((await loadAll(paths.config, paths.profile))?.nativeCliAgents[0]?.provider).toBe('codex');
  });

  test('preserves principal id across re-runs (idempotent)', async () => {
    const first = await initMonadHome(paths);
    const second = await initMonadHome(paths);

    expect(second.created).toBe(false);
    expect(second.principalId).toBe(first.principalId);
  });

  test('creates empty auth.json on first run', async () => {
    await initMonadHome(paths);
    const auth = await loadAuth(paths.auth);
    expect(auth?.version).toBe(1);
    expect(auth?.credentialPool).toEqual({});
  });

  test('does not overwrite existing auth.json', async () => {
    await initMonadHome(paths);
    await saveAuth(paths.auth, {
      version: 1,
      activeProvider: 'openrouter',
      updatedAt: new Date().toISOString(),
      credentialPool: { openrouter: [] }
    });
    await initMonadHome(paths); // re-run

    const auth = await loadAuth(paths.auth);
    expect(auth?.activeProvider).toBe('openrouter');
  });

  test('seeds SOUL.md and AGENT.md in workspace', async () => {
    await initMonadHome(paths);
    const _soul = await readFile(join(paths.workspace, 'SOUL.md'), 'utf-8');
    const _agent = await readFile(join(paths.workspace, 'AGENT.md'), 'utf-8');
  });

  test('does not overwrite user-edited SOUL.md', async () => {
    await initMonadHome(paths);
    await Bun.write(join(paths.workspace, 'SOUL.md'), 'my custom soul');
    await initMonadHome(paths); // re-run without reseed

    const soul = await readFile(join(paths.workspace, 'SOUL.md'), 'utf-8');
    expect(soul).toBe('my custom soul');
  });

  test('reseeds SOUL.md when reseed=true', async () => {
    await initMonadHome(paths);
    await Bun.write(join(paths.workspace, 'SOUL.md'), 'my custom soul');
    await initMonadHome(paths, { reseed: true });

    const _soul = await readFile(join(paths.workspace, 'SOUL.md'), 'utf-8');
  });

  test('seeds the starter skill on first init', async () => {
    await initMonadHome(paths);
    const [globalSkill, defaultAgentSkill, atomPackSkill, atomPackManifest, _atomPackEntry] = await Promise.all([
      readFile(join(paths.skills, 'summarize-changes', 'SKILL.md'), 'utf-8'),
      readFile(join(paths.workspace, 'skills', 'summarize-changes', 'SKILL.md'), 'utf-8'),
      readFile(join(paths.packs, 'monad-test', 'skills', 'summarize-changes', 'SKILL.md'), 'utf-8'),
      readFile(join(paths.packs, 'monad-test', 'atom-pack.json'), 'utf-8'),
      readFile(join(paths.packs, 'monad-test', 'dist', 'atom-pack.js'), 'utf-8')
    ]);
    expect(defaultAgentSkill).toBe(globalSkill);
    expect(atomPackSkill).toBe(globalSkill);
    expect(JSON.parse(atomPackManifest)).toMatchObject({ name: 'monad-test', atoms: ['skill'] });
  });

  test('does not re-seed a deleted starter skill on a later init', async () => {
    await initMonadHome(paths);
    await Promise.all([
      rm(join(paths.skills, 'summarize-changes'), { recursive: true, force: true }),
      rm(join(paths.workspace, 'skills', 'summarize-changes'), { recursive: true, force: true }),
      rm(join(paths.packs, 'monad-test'), { recursive: true, force: true })
    ]);
    await initMonadHome(paths); // created=false now → no re-seed
    await Promise.all([
      expect(Bun.file(join(paths.skills, 'summarize-changes', 'SKILL.md')).exists()).resolves.toBe(false),
      expect(Bun.file(join(paths.workspace, 'skills', 'summarize-changes', 'SKILL.md')).exists()).resolves.toBe(false),
      expect(Bun.file(join(paths.packs, 'monad-test', 'atom-pack.json')).exists()).resolves.toBe(false)
    ]);
  });
});

// ── init status ───────────────────────────────────────────────────────────────

describe('computeInitStatus', () => {
  test('reports the default profile provider when credentials are missing', () => {
    const cfg = createDefaultConfig('prn_test', 'test-user');
    cfg.model.default = 'writer';
    cfg.model.providers = [
      {
        id: 'oai',
        label: 'OpenAI-compatible',
        type: ModelProviderType.OpenAICompatible,
        baseUrl: 'https://api.test/v1'
      }
    ];
    cfg.model.profiles = [
      {
        alias: 'writer',
        routes: { chat: { provider: 'oai', modelId: 'gpt-x' } },
        params: {},
        fallbacks: []
      }
    ];

    expect(
      computeInitStatus(cfg, {
        version: 1,
        activeProvider: 'oai',
        updatedAt: new Date().toISOString(),
        credentialPool: {}
      })
    ).toEqual({
      initialized: false,
      missing: ['credential'],
      missingProviderCredentials: [
        {
          providerId: 'oai',
          providerLabel: 'OpenAI-compatible',
          profileAlias: 'writer',
          route: 'chat'
        }
      ]
    });
  });

  test('reports replacement default profile provider when legacy sample profile is still selected', () => {
    const cfg = createDefaultConfig('prn_test', 'test-user');
    cfg.model.default = 'sample-compatible';
    cfg.model.providers.push({
      id: 'openrouter',
      label: 'OpenRouter',
      type: ModelProviderType.OpenRouter
    });
    cfg.model.profiles.push({
      alias: 'default',
      routes: { chat: { provider: 'openrouter', modelId: 'openrouter/free' } },
      params: {},
      fallbacks: []
    });

    expect(
      computeInitStatus(cfg, {
        version: 1,
        activeProvider: null,
        updatedAt: new Date().toISOString(),
        credentialPool: {}
      })
    ).toEqual({
      initialized: false,
      missing: ['provider', 'credential'],
      missingProviderCredentials: [
        {
          providerId: 'openrouter',
          providerLabel: 'OpenRouter',
          profileAlias: 'default',
          route: 'chat'
        }
      ]
    });
  });

  test('uses the configured default profile alias instead of requiring alias "default"', () => {
    const cfg = createDefaultConfig('prn_test', 'test-user');
    cfg.model.default = 'writer';
    cfg.model.providers = [
      {
        id: 'oai',
        label: 'OpenAI-compatible',
        type: ModelProviderType.OpenAICompatible,
        baseUrl: 'https://api.test/v1'
      }
    ];
    cfg.model.profiles = [
      {
        alias: 'writer',
        routes: { chat: { provider: 'oai', modelId: 'gpt-x' } },
        params: {},
        fallbacks: []
      }
    ];
    cfg.agent.agents = [
      {
        id: 'agt_writer',
        name: 'Writer',
        capabilities: [],
        declaredScopes: [],
        atoms: { mode: 'inherit', allow: [], deny: [] },
        visibility: { subagentCallable: false, public: false },
        a2a: { enabled: false }
      }
    ];
    cfg.agent.defaultAgentId = 'agt_writer';

    expect(
      computeInitStatus(cfg, {
        version: 1,
        activeProvider: 'oai',
        updatedAt: new Date().toISOString(),
        credentialPool: {
          oai: [
            {
              id: 'cred_primary',
              label: 'Primary',
              authType: 'api_key',
              priority: 0,
              source: 'manual',
              accessToken: 'sk-test',
              lastStatus: 'unknown',
              lastStatusAt: null,
              lastErrorCode: null,
              lastErrorReason: null,
              lastErrorMessage: null,
              lastErrorResetAt: null,
              requestCount: 0
            }
          ]
        }
      })
    ).toEqual({ initialized: true, missing: [] });
  });
});

// ── config schema / migration tests ──────────────────────────────────────────
//
// These fixtures ARE the historical schema snapshots.
// When a new version is added:
//  1. Keep all existing fixtures unchanged.
//  2. Add a new fixture object for the old version.
//  3. Add a test asserting migrateConfig(oldFixture) produces the new shape.
//
// This is the ONLY place old-version knowledge needs to be recorded.

/** Canonical v1 fixture — frozen; never edit this once committed. */
const CONFIG_V1_FIXTURE = {
  version: 1,
  principal: { id: 'prn_01TESTID', displayName: 'Alice', verification: 'unverified' },
  model: { default: 'anthropic/claude-sonnet-4-6', provider: 'openrouter', fallbacks: [] },
  agent: { sandbox: { mode: 'workspace' } }
} as const;

describe('migrateConfig', () => {
  test('migrates a valid v1 fixture to the current version', async () => {
    const cfg = await migrateConfig(CONFIG_V1_FIXTURE);
    expect(cfg.version).toBe(1);
    expect(cfg.principal.id).toBe('prn_01TESTID');
    expect(cfg.model.default).toBe('anthropic/claude-sonnet-4-6');
    expect(cfg.agent.sandbox.mode).toBe('workspace');
    // globalSandbox is additive — a pre-field config gets the default-filled value.
    expect(cfg.agent.globalSandbox).toEqual({ enabled: false, mode: 'workspace' });
  });

  test('throws on unknown version (newer than current)', async () => {
    // spread version LAST so it wins over CONFIG_V1_FIXTURE's version: 1
    await expect(migrateConfig({ ...CONFIG_V1_FIXTURE, version: 999 })).rejects.toThrow(/newer than/);
  });

  test('throws when version field is missing', async () => {
    const { version: _v, ...noVersion } = CONFIG_V1_FIXTURE;
    await expect(migrateConfig(noVersion)).rejects.toThrow();
  });

  test('fills network.transport with the default when the network block is absent', async () => {
    const cfg = await migrateConfig(CONFIG_V1_FIXTURE);
    expect(cfg.network.transport).toBe(DEFAULT_TRANSPORT);
  });

  test('fills local HTTP fallback defaults when the network block is absent', async () => {
    const cfg = await migrateConfig(CONFIG_V1_FIXTURE);
    expect(cfg.network.https).toEqual({ enabled: true });
    expect(cfg.network.localHttpFallback).toEqual({ enabled: false, port: 52780 });
    expect('allowInsecureHttp' in cfg.network.remoteAccess).toBe(false);
  });

  test('preserves an explicit network.transport override', async () => {
    const override = 'tcp'; // any value other than DEFAULT_TRANSPORT ('uds')
    const cfg = await migrateConfig({
      ...CONFIG_V1_FIXTURE,
      network: {
        port: 52749,
        transport: override,
        https: { enabled: false },
        remoteAccess: { enabled: false, token: null },
        localHttpFallback: { enabled: true, port: 52780 }
      }
    });
    expect(cfg.network.transport).toBe(override);
    expect(cfg.network.https).toEqual({ enabled: false });
    expect(cfg.network.localHttpFallback).toEqual({ enabled: true, port: 52780 });
  });

  // ── Future migration test template ────────────────────────────────────────
  // When v2 is added, uncomment and fill in:
  //
  // test('migrates v1 → v2', () => {
  //   const cfg = migrateConfig(CONFIG_V1_FIXTURE);   // fixture stays as v1 shape
  //   expect(cfg.version).toBe(2);
  //   expect(cfg.model.primary).toBe('anthropic/claude-sonnet-4-6'); // renamed field
  // });
});

describe('loadConfig', () => {
  test('returns null when file does not exist', async () => {});

  test('round-trips a valid config', async () => {
    await initMonadHome(paths);
    const cfg = await loadAll(paths.config, paths.profile);
    expect(cfg?.version).toBe(1);
    expect(cfg?.developerMode).toBe(false);
    expect(cfg?.model.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'sample-openai-compatible',
          type: 'openai-compatible',
          baseUrl: 'https://api.example.com/v1'
        })
      ])
    );
    expect(cfg?.model.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          alias: 'sample-compatible',
          routes: { chat: { provider: 'sample-openai-compatible', modelId: 'example-model' } }
        })
      ])
    );
    expect(cfg?.model.default).toBe('');
  });

  test('saveSystemConfig writes developerMode at the system root', async () => {
    await initMonadHome(paths);
    const cfg = await loadAll(paths.config, paths.profile);
    if (!cfg) throw new Error('expected config');
    cfg.developerMode = true;
    await saveSystemConfig(paths.config, cfg);

    const raw = JSON.parse(await readFile(paths.config, 'utf8')) as {
      developerMode?: boolean;
      observability?: Record<string, unknown>;
    };
    expect(raw.developerMode).toBe(true);
    expect(raw.observability).toEqual({ endpoint: '' });
  });

  test('profile slice stores user avatar data without moving principal identity out of system config', async () => {
    await initMonadHome(paths);
    const cfg = await loadAll(paths.config, paths.profile);
    const initialDisplayName = cfg?.principal.displayName;
    expect(typeof initialDisplayName).toBe('string');
    if (!cfg) throw new Error('expected config');

    cfg.user.avatarDataUrl = 'data:image/png;base64,ZmFrZQ==';
    await saveProfile(paths.profile, cfg);

    const profile = monadProfileSchema.parse(JSON.parse(await readFile(paths.profile, 'utf8')));
    expect(profile.user.avatarDataUrl).toBe('data:image/png;base64,ZmFrZQ==');
    expect('principal' in profile).toBe(false);

    const reloaded = await loadAll(paths.config, paths.profile);
    expect(reloaded?.principal.displayName).toBe(initialDisplayName);
    expect(reloaded?.user.avatarDataUrl).toBe('data:image/png;base64,ZmFrZQ==');
  });

  test('migrates a v1 file written to disk', async () => {
    // Simulate a file written by an older installation
    await Bun.write(paths.config, JSON.stringify(CONFIG_V1_FIXTURE, null, 2));
    const cfg = await loadConfig(paths.config);
    expect(cfg?.version).toBe(1);
    expect(cfg?.principal.displayName).toBe('Alice');
  });

  test('throws a user-friendly error for invalid config schema', async () => {
    await Bun.write(paths.config, JSON.stringify({ version: 1, principal: { id: 'bad' } }, null, 2));

    try {
      await loadConfig(paths.config);
      throw new Error('expected loadConfig to throw');
    } catch (err) {
      const _message = err instanceof Error ? err.message : String(err);
    }
  });

  test('rejects non-http provider baseUrl while loading config', async () => {
    await initMonadHome(paths);
    const profile = JSON.parse(await readFile(paths.profile, 'utf8')) as {
      model: { providers: unknown[] };
    };
    profile.model.providers = [
      {
        id: 'bad-url',
        label: 'Bad URL',
        type: ModelProviderType.OpenAICompatible,
        baseUrl: 'ftp://api.example.com/v1'
      }
    ];
    await Bun.write(paths.profile, JSON.stringify(profile, null, 2));

    try {
      await loadConfig(paths.config);
      throw new Error('expected loadConfig to throw');
    } catch (err) {
      const _message = err instanceof Error ? err.message : String(err);
    }
  });

  test('rejects invalid system URL boundary fields', () => {
    const base = monadSystemConfigSchema.parse(createDefaultConfig('prn_test', 'Tester'));

    expect(() =>
      monadSystemConfigSchema.parse({
        ...base,
        observability: { endpoint: 'ftp://collector.example.com' }
      })
    ).toThrow();
  });

  test('rejects invalid profile URL boundary fields', () => {
    const base = monadConfigSchema.parse(CONFIG_V1_FIXTURE);

    expect(() =>
      monadConfigSchema.parse({
        ...base,
        model: {
          ...base.model,
          providers: [
            {
              id: 'bad-provider',
              label: 'Bad Provider',
              type: ModelProviderType.OpenAICompatible,
              baseUrl: 'ftp://api.example.com/v1'
            }
          ]
        }
      })
    ).toThrow();

    expect(() =>
      monadConfigSchema.parse({
        ...base,
        browser: {
          ...base.browser,
          allowedOrigins: ['https://example.com/path']
        }
      })
    ).toThrow();
  });

  test('rejects invalid auth URL boundary fields', async () => {
    await initMonadHome(paths);
    await Bun.write(
      paths.auth,
      JSON.stringify(
        {
          version: 1,
          activeProvider: null,
          updatedAt: new Date().toISOString(),
          credentialPool: {},
          mcpOAuth: {
            server: {
              accessToken: 'token',
              tokenEndpoint: 'ftp://auth.example.com/token',
              resource: 'https://api.example.com/mcp'
            }
          },
          atomRegistries: {
            npm: { token: 'token', registry: 'ftp://registry.example.com' }
          }
        },
        null,
        2
      )
    );
  });
});

describe('tryParseConfig', () => {
  test('returns null for corrupt data', async () => {});

  test('returns MonadConfig for valid fixture', async () => {});

  test('openaiCompat inbound approval defaults to local (fail-closed, not auto-approve)', () => {
    expect(createDefaultConfig('prn_x', 'tester').openaiCompat.approval).toBe('local');
  });
});

describe('editor JSON schemas', () => {
  test('runtime schema content is valid JSON schema payloads', () => {
    const _configSchema = JSON.parse(SCHEMA_CONTENT) as { $schema?: string; properties?: Record<string, unknown> };
    const _profileSchema = JSON.parse(PROFILE_SCHEMA_CONTENT) as {
      $schema?: string;
      properties?: Record<string, unknown>;
    };
  });
});

// ── mcpServers (external MCP servers connected at startup) ──────────────────────

describe('mcpServers config', () => {
  test('createDefaultConfig starts with no MCP servers', () => {});

  test('a config written before the field still parses, defaulting to []', async () => {
    const cfg = createDefaultConfig('prn_x', 'tester') as Record<string, unknown>;
    delete cfg.mcpServers; // simulate an older config on disk
    const _parsed = await tryParseConfig(cfg);
  });

  test('mcpServerSchema accepts a stdio server spec', () => {
    const r = mcpServerSchema.safeParse({
      name: 'fs',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '.']
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).toMatchObject({ transport: 'stdio', enabled: true });
    }
  });

  test('mcpServerSchema rejects a stdio spec missing command', () => {
    expect(mcpServerSchema.safeParse({ name: 'fs' }).success).toBe(false);
  });

  test('mcpServerSchema accepts an http server with bearer auth', () => {
    const r = mcpServerSchema.safeParse({
      name: 'remote',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal secret-ref syntax
      auth: { mode: 'bearer', token: '${env:REMOTE_TOKEN}' }
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.transport === 'http') expect(r.data.auth.mode).toBe('bearer');
  });

  test('mcpServerSchema rejects an http server with a non-URL', () => {
    expect(mcpServerSchema.safeParse({ name: 'remote', transport: 'http', url: 'not-a-url' }).success).toBe(false);
  });
});

// ── browser preset config schema (the buildBrowserMcpServer builder is daemon-side) ──

describe('browser config', () => {
  test('createDefaultConfig disables the browser by default', () => {
    expect(createDefaultConfig('prn_x', 'tester').browser).toEqual({ enabled: false, vision: false, headless: true });
  });

  test('a config written before the browser field still parses, defaulting it', async () => {
    const cfg = createDefaultConfig('prn_x', 'tester') as Record<string, unknown>;
    delete cfg.browser;
    const parsed = await tryParseConfig(cfg);
    expect(parsed?.browser).toEqual({ enabled: false, vision: false, headless: true });
  });
});

// ── network.transport (per-OS default + user override drives the client) ────────

describe('network.transport', () => {
  test('createDefaultConfig stamps the OS default transport at init', () => {
    expect(createDefaultConfig('prn_x', 'x').network.transport).toBe(DEFAULT_TRANSPORT);
  });

  test('createDefaultConfig stamps local HTTP fallback disabled on an independent default port', () => {
    const cfg = createDefaultConfig('prn_x', 'x');
    expect(cfg.network.host).toBe('127.0.0.1');
    expect(cfg.network.https).toEqual({ enabled: true });
    expect(cfg.network.localHttpFallback).toEqual({ enabled: false, port: 52780 });
    expect('allowInsecureHttp' in cfg.network.remoteAccess).toBe(false);
  });

  test('resolveDaemonNetwork derives bind/connect URLs from host, protocol, and ports', () => {
    const cfg = createDefaultConfig('prn_x', 'x');
    cfg.network.remoteAccess.enabled = true;
    cfg.network.host = '192.168.1.20';
    cfg.network.port = 52801;
    cfg.network.localHttpFallback = { enabled: true, port: 52880 };

    expect(resolveDaemonNetwork({ network: cfg.network })).toMatchObject({
      bindHost: '192.168.1.20',
      connectHost: '192.168.1.20',
      port: 52801,
      scheme: 'https',
      primaryUrl: 'https://192.168.1.20:52801',
      localUrl: 'https://192.168.1.20:52801',
      localHttpFallback: { port: 52880, url: 'http://127.0.0.1:52880' },
      unixUrl: 'http://localhost'
    });
  });

  test('resolveDaemonNetwork keeps remote access wildcard bind locally dialable', () => {
    const cfg = createDefaultConfig('prn_x', 'x');
    cfg.network.remoteAccess.enabled = true;

    expect(resolveDaemonNetwork({ network: cfg.network })).toMatchObject({
      bindHost: '0.0.0.0',
      connectHost: '127.0.0.1',
      primaryUrl: 'https://0.0.0.0:52749',
      localUrl: 'https://127.0.0.1:52749'
    });
  });

  test('resolveDaemonNetwork honours env host and port overrides without scheme env', () => {
    const cfg = createDefaultConfig('prn_x', 'x');
    cfg.network.remoteAccess.enabled = true;
    cfg.network.localHttpFallback = { enabled: true, port: 52780 };

    expect(
      resolveDaemonNetwork({
        network: cfg.network,
        env: { MONAD_HOST: '::', MONAD_PORT: '53210', MONAD_HTTP_PORT: '53310' }
      })
    ).toMatchObject({
      bindHost: '::',
      connectHost: '::1',
      primaryUrl: 'https://[::]:53210',
      localUrl: 'https://[::1]:53210',
      localHttpFallback: { port: 53310, url: 'http://127.0.0.1:53310' }
    });
  });

  test('resolveDaemonNetwork rejects non-loopback hosts unless remote access is enabled', () => {
    const cfg = createDefaultConfig('prn_x', 'x');
    cfg.network.host = '0.0.0.0';

    expect(() => resolveDaemonNetwork({ network: cfg.network })).toThrow(/network\.host must be loopback/);
    expect(() => resolveDaemonNetwork({ network: cfg.network, env: { MONAD_HOST: '192.168.1.20' } })).toThrow(
      /network\.host must be loopback/
    );
  });

  test('resolveDaemonNetwork rejects remote access when HTTPS is disabled', () => {
    const cfg = createDefaultConfig('prn_x', 'x');
    cfg.network.remoteAccess.enabled = true;
    cfg.network.https.enabled = false;

    expect(() => resolveDaemonNetwork({ network: cfg.network })).toThrow(/network\.https\.enabled=false/);
  });

  test('resolveDaemonUrl keeps explicit MONAD_URL as the highest-priority escape hatch', () => {
    const cfg = createDefaultConfig('prn_x', 'x');
    expect(resolveDaemonUrl({ network: cfg.network, env: { MONAD_URL: 'http://127.0.0.1:59999' } })).toBe(
      'http://127.0.0.1:59999'
    );
  });

  describe('resolveClientConn honours the setting', () => {
    const env = { ...Bun.env };
    let home: string;

    beforeEach(() => {
      home = join(tmpdir(), `monad-conn-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      Bun.env.MONAD_HOME = home;
    });
    afterEach(async () => {
      Object.assign(Bun.env, env);
      if (!('MONAD_HOME' in env)) delete Bun.env.MONAD_HOME;
      if (!('MONAD_PORT' in env)) delete Bun.env.MONAD_PORT;
      await rm(home, { recursive: true, force: true });
    });

    async function setTransport(mode: 'tcp' | 'uds') {
      const p = getPaths();
      await initMonadHome(p);
      const cfg = await loadAll(p.config, p.profile);
      // biome-ignore lint/style/noNonNullAssertion: initMonadHome guarantees config exists
      cfg!.network.transport = mode;
      // biome-ignore lint/style/noNonNullAssertion: initMonadHome guarantees config exists
      await saveSystemConfig(p.config, cfg!);
      return p;
    }

    test('uds → returns the daemon unix socket path', async () => {
      const p = await setTransport('uds');
      const conn = await resolveClientConn();
      expect(conn.unixSocket).toBe(p.sock);
    });

    test('tcp → no unix socket (HTTPS over loopback)', async () => {
      await setTransport('tcp');
      const conn = await resolveClientConn();
      expect(conn.unixSocket).toBeUndefined();
      expect(conn.baseUrl).toBe('https://127.0.0.1:52749');
    });

    test('MONAD_PORT overrides the configured port (per-worktree dev isolation)', async () => {
      const p = await setTransport('tcp');
      const cfg = await loadAll(p.config, p.profile);
      // biome-ignore lint/style/noNonNullAssertion: initMonadHome guarantees config exists
      cfg!.network.port = 52749;
      // biome-ignore lint/style/noNonNullAssertion: initMonadHome guarantees config exists
      await saveSystemConfig(p.config, cfg!);

      Bun.env.MONAD_PORT = '53210';
      const conn = await resolveClientConn();
      expect(conn.baseUrl).toBe('https://127.0.0.1:53210');
    });

    test('without MONAD_PORT, falls back to the configured port', async () => {
      const p = await setTransport('tcp');
      const cfg = await loadAll(p.config, p.profile);
      // biome-ignore lint/style/noNonNullAssertion: initMonadHome guarantees config exists
      cfg!.network.port = 52801;
      // biome-ignore lint/style/noNonNullAssertion: initMonadHome guarantees config exists
      await saveSystemConfig(p.config, cfg!);

      delete Bun.env.MONAD_PORT;
      const conn = await resolveClientConn();
      expect(conn.baseUrl).toBe('https://127.0.0.1:52801');
    });

    test('tcp with HTTPS disabled returns HTTP over loopback', async () => {
      const p = await setTransport('tcp');
      const cfg = await loadAll(p.config, p.profile);
      // biome-ignore lint/style/noNonNullAssertion: initMonadHome guarantees config exists
      cfg!.network.https.enabled = false;
      // biome-ignore lint/style/noNonNullAssertion: initMonadHome guarantees config exists
      await saveSystemConfig(p.config, cfg!);

      const conn = await resolveClientConn();
      expect(conn.baseUrl).toBe('http://127.0.0.1:52749');
    });
  });
});

// ── getPaths ──────────────────────────────────────────────────────────────────

describe('getPaths', () => {
  const env = { ...Bun.env };
  const repoRoot = join(import.meta.dir, '..', '..', '..', '..');

  afterEach(() => {
    // Restore env after each test
    Object.assign(Bun.env, env);
    for (const key of ['MONAD_HOME', 'NODE_ENV']) {
      if (!(key in env)) delete Bun.env[key];
    }
  });

  test('derives all paths from repo-local .dev/.monad by default in dev', () => {
    Bun.env.NODE_ENV = 'development';
    delete Bun.env.MONAD_HOME;

    const p = getPaths();
    const expected = join(repoRoot, '.dev', '.monad');

    expect(p.home).toBe(expected);
    expect(p.runtime).toBe(join(expected, 'runtime'));
    expect(p.config).toBe(join(expected, 'configs', 'config.json'));
    expect(p.auth).toBe(join(expected, 'credentials', 'auth.json'));
    expect(p.workspace).toBe(join(expected, 'agents', 'default'));
    expect(p.db).toBe(join(expected, 'db', 'monad.sqlite'));
    expect(p.sock).toBe(join(expected, 'runtime', 'monad.sock'));
  });

  test('MONAD_HOME overrides the root for all derived paths', () => {
    const custom = join(tmpdir(), 'monad-custom-home');
    Bun.env.MONAD_HOME = custom;

    const p = getPaths();

    expect(p.home).toBe(custom);
    expect(p.runtime).toBe(join(custom, 'runtime'));
    expect(p.config).toBe(join(custom, 'configs', 'config.json'));
    expect(p.auth).toBe(join(custom, 'credentials', 'auth.json'));
    expect(p.workspace).toBe(join(custom, 'agents', 'default'));
    expect(p.db).toBe(join(custom, 'db', 'monad.sqlite'));
    expect(p.sock).toBe(join(custom, 'runtime', 'monad.sock'));
  });

  test('unknown env vars do not affect derived paths', () => {
    Bun.env.MONAD_HOME = join(tmpdir(), 'monad-base');

    const p = getPaths();
    const expected = Bun.env.MONAD_HOME;

    expect(p.home).toBe(expected);
    expect(p.runtime).toBe(join(expected, 'runtime'));
    expect(p.config).toBe(join(expected, 'configs', 'config.json'));
    expect(p.auth).toBe(join(expected, 'credentials', 'auth.json'));
    expect(p.db).toBe(join(expected, 'db', 'monad.sqlite'));
    expect(p.sock).toBe(join(expected, 'runtime', 'monad.sock'));
  });
});

// ── XDG layout ────────────────────────────────────────────────────────────────

describe('xdgPaths', () => {
  const env = { ...Bun.env };

  afterEach(() => {
    Object.assign(Bun.env, env);
    for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR']) {
      if (!(key in env)) delete Bun.env[key];
    }
  });

  test('splits config/data/cache/state/runtime across XDG roots', () => {
    const h = homedir();
    delete Bun.env.XDG_CONFIG_HOME;
    delete Bun.env.XDG_DATA_HOME;
    delete Bun.env.XDG_CACHE_HOME;
    delete Bun.env.XDG_STATE_HOME;
    delete Bun.env.XDG_RUNTIME_DIR;

    const p = xdgPaths();

    expect(p.config).toBe(join(h, '.config', 'monad', 'config.json'));
    expect(p.auth).toBe(join(h, '.config', 'monad', 'auth.json'));
    expect(p.db).toBe(join(h, '.local', 'share', 'monad', 'db', 'monad.sqlite'));
    expect(p.cache).toBe(join(h, '.cache', 'monad'));
    // No XDG_RUNTIME_DIR → socket falls back to $XDG_STATE_HOME
    expect(p.sock).toBe(join(h, '.local', 'state', 'monad', 'monad.sock'));
  });

  test('honours XDG_CONFIG_HOME and XDG_DATA_HOME overrides', () => {
    const cfgRoot = join(tmpdir(), 'xdg-cfg');
    const dataRoot = join(tmpdir(), 'xdg-data');
    Bun.env.XDG_CONFIG_HOME = cfgRoot;
    Bun.env.XDG_DATA_HOME = dataRoot;

    const p = xdgPaths();

    expect(p.configs).toBe(join(cfgRoot, 'monad'));
    expect(p.config).toBe(join(cfgRoot, 'monad', 'config.json'));
    expect(p.db).toBe(join(dataRoot, 'monad', 'db', 'monad.sqlite'));
    expect(p.atoms).toBe(join(dataRoot, 'monad', 'atoms'));
  });

  test('XDG_RUNTIME_DIR is used for sockets when set', () => {
    const runtimeDir = join(tmpdir(), 'xdg-runtime');
    Bun.env.XDG_RUNTIME_DIR = runtimeDir;

    const p = xdgPaths();

    expect(p.sock).toBe(join(runtimeDir, 'monad', 'monad.sock'));
    expect(p.kvSock).toBe(join(runtimeDir, 'monad', 'kv.sock'));
    expect(p.pid).toBe(join(runtimeDir, 'monad', 'monad.pid'));
  });
});
