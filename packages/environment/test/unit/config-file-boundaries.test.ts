import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('config file boundaries', () => {
  test('paths expose config, agents, mesh, and auth files only', async () => {
    const { pathsForHome } = await import('../../src/paths.ts');
    const home = '/tmp/monad-config-boundaries';
    const paths = pathsForHome(home);

    expect({
      config: paths.config,
      agentsConfig: paths.agentsConfig,
      mesh: paths.mesh,
      auth: paths.auth
    }).toEqual({
      config: join(home, 'configs', 'config.json'),
      agentsConfig: join(home, 'configs', 'agents.json'),
      mesh: join(home, 'configs', 'mesh.json'),
      auth: join(home, 'credentials', 'auth.json')
    });
    expect('profile' in paths).toBe(false);
    expect('sandbox' in paths).toBe(false);
  });

  test('saveAll writes independent config, agents, and mesh documents', async () => {
    const { createDefaultConfig, loadAll, saveAll } = await import('../../src/config/index.ts');
    const { pathsForHome } = await import('../../src/paths.ts');
    const home = await mkdtemp(join(tmpdir(), 'monad-config-files-'));
    const paths = pathsForHome(home);
    const cfg = createDefaultConfig('Operator');

    await saveAll(paths, cfg);

    const config = JSON.parse(await Bun.file(paths.config).text()) as Record<string, unknown>;
    const agents = JSON.parse(await Bun.file(paths.agentsConfig).text()) as Record<string, unknown>;
    const mesh = JSON.parse(await Bun.file(paths.mesh).text()) as Record<string, unknown>;

    expect(Object.keys(config).sort()).toEqual([
      '$schema',
      'appearance',
      'atomExperienceReview',
      'atomPins',
      'atomRegistries',
      'channels',
      'developerMode',
      'locale',
      'logs',
      'network',
      'observability',
      'openaiCompat',
      'user',
      'version'
    ]);
    expect(Object.keys(agents).sort()).toEqual([
      '$schema',
      'agent',
      'browser',
      'computer',
      'context',
      'mcpServers',
      'memory',
      'model',
      'obscura',
      'sandbox',
      'skills',
      'version'
    ]);
    expect(Object.keys(mesh).sort()).toEqual(['$schema', 'acpAgents', 'meshAgents', 'monadix', 'peers', 'version']);
    expect((config.$schema as string).endsWith('/config.schema.json')).toBe(true);
    expect((agents.$schema as string).endsWith('/agents.schema.json')).toBe(true);
    expect((mesh.$schema as string).endsWith('/mesh.schema.json')).toBe(true);
    expect(await loadAll(paths)).toEqual(cfg);
  });

  test('system config defaults an absent log cleanup policy', async () => {
    const { monadSystemConfigSchema } = await import('../../src/config/config.ts');

    expect(monadSystemConfigSchema.parse({ version: 1 }).logs).toEqual({
      autoCleanup: { enabled: true, retentionDays: 14 }
    });
  });

  test('persisted log cleanup policy preserves valid values', async () => {
    const { parseSystemConfigWithWarnings } = await import('../../src/config/config-io.ts');

    expect(
      parseSystemConfigWithWarnings({ version: 1, logs: { autoCleanup: { enabled: false, retentionDays: 30 } } })
    ).toEqual({
      cfg: expect.objectContaining({ logs: { autoCleanup: { enabled: false, retentionDays: 30 } } }),
      warnings: []
    });
  });

  test('persisted config recovers only an invalid log cleanup policy', async () => {
    const { parseSystemConfigWithWarnings } = await import('../../src/config/config-io.ts');

    expect(
      parseSystemConfigWithWarnings({ version: 1, logs: { autoCleanup: { enabled: true, retentionDays: 99 } } })
    ).toEqual({
      cfg: expect.objectContaining({ logs: { autoCleanup: { enabled: true, retentionDays: 14 } } }),
      warnings: ['logs.autoCleanup']
    });
    expect(() => parseSystemConfigWithWarnings({ version: 1, locale: 42 })).toThrow();
  });

  test('generated schemas match the four persisted documents', async () => {
    const { AGENTS_SCHEMA_CONTENT } = await import('../../src/config/agents.ts');
    const { AUTH_SCHEMA_CONTENT } = await import('../../src/config/auth.ts');
    const { CONFIG_SCHEMA_CONTENT } = await import('../../src/config/config.ts');
    const { MESH_SCHEMA_CONTENT } = await import('../../src/config/mesh.ts');

    const keys = (content: string) =>
      Object.keys((JSON.parse(content) as { properties: Record<string, unknown> }).properties).sort();

    expect(keys(CONFIG_SCHEMA_CONTENT)).toEqual([
      '$schema',
      'appearance',
      'atomExperienceReview',
      'atomPins',
      'atomRegistries',
      'channels',
      'developerMode',
      'locale',
      'logs',
      'network',
      'observability',
      'openaiCompat',
      'user',
      'version'
    ]);
    expect(keys(AGENTS_SCHEMA_CONTENT)).toEqual([
      '$schema',
      'agent',
      'browser',
      'computer',
      'context',
      'hooks',
      'mcpServers',
      'memory',
      'model',
      'obscura',
      'policyHooks',
      'sandbox',
      'skills',
      'version'
    ]);
    expect(keys(MESH_SCHEMA_CONTENT)).toEqual(['$schema', 'acpAgents', 'meshAgents', 'monadix', 'peers', 'version']);
    expect(keys(AUTH_SCHEMA_CONTENT)).toEqual(['$schema', 'credentials', 'updatedAt', 'version']);
  });
});
