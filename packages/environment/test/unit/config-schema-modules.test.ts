import { describe, expect, test } from 'bun:test';

describe('config schema module ownership', () => {
  test('auth owns the auth.json contract', async () => {
    const { emptyAuth, monadAuthSchema } = await import('../../src/config/auth.ts');
    const auth = emptyAuth();

    expect(monadAuthSchema.parse(auth)).toEqual(auth);
  });

  test('agents owns Monad agent definitions and capability infrastructure', async () => {
    const {
      agentConfigSchema,
      browserConfigSchema,
      computerConfigSchema,
      contextSettingsSchema,
      mcpServerSchema,
      memorySettingsSchema,
      obscuraConfigSchema,
      sandboxConfigSchema
    } = await import('../../src/config/agents.ts');
    expect(() => agentConfigSchema.parse({ id: 'agt_000000000001', name: 'Default' })).toThrow();
    expect(
      agentConfigSchema.parse({
        id: 'agt_000000000001',
        name: 'Default',
        memory: {
          enabled: true,
          advanced: true,
          autoConsolidate: false,
          intervalMinutes: 30
        }
      })
    ).toMatchObject({
      name: 'Default',
      capabilities: [],
      declaredScopes: [],
      memory: {
        enabled: true,
        advanced: true,
        autoConsolidate: false,
        intervalMinutes: 30
      }
    });
    expect(mcpServerSchema.parse({ name: 'files', transport: 'stdio', command: 'files-mcp' })).toMatchObject({
      name: 'files',
      transport: 'stdio',
      enabled: true
    });
    expect(browserConfigSchema.parse({})).toEqual({ enabled: false, vision: false, headless: true });
    expect(computerConfigSchema.parse({})).toEqual({
      enabled: false,
      command: 'uvx',
      args: ['computer-control-mcp@latest']
    });
    expect(obscuraConfigSchema.parse({})).toEqual({ enabled: false, stealth: false });
    expect(sandboxConfigSchema.parse({})).toMatchObject({ mode: 'workspace', confine: true });
    expect(memorySettingsSchema.parse({})).toEqual({ backend: 'builtin', mem0: {} });
    expect(memorySettingsSchema.safeParse(JSON.parse('{"level":3}')).success).toBe(false);
    expect(
      memorySettingsSchema.safeParse({
        backend: 'builtin',
        mem0: {},
        graph: { autoConsolidate: true, intervalMinutes: 30 }
      }).success
    ).toBe(false);
    expect(contextSettingsSchema.parse({})).toMatchObject({
      eviction: { enabled: true },
      summarize: { background: true }
    });
  });

  test('mesh owns Workspace collaborators and cross-node connections', async () => {
    const { acpAgentSchema, meshAgentSchema, monadixConfigSchema, peerSchema } = await import(
      '../../src/config/mesh.ts'
    );
    expect(acpAgentSchema.parse({ name: 'reviewer', command: 'review-agent' })).toMatchObject({
      name: 'reviewer',
      enabled: true
    });
    expect(
      meshAgentSchema.parse({
        name: 'openclaw--test',
        displayName: 'test',
        provider: 'openclaw',
        command: 'openclaw',
        enabled: true,
        discovery: {
          connectorName: 'openclaw',
          externalId: 'test',
          state: 'available'
        }
      })
    ).toMatchObject({
      name: 'openclaw--test',
      displayName: 'test',
      provider: 'openclaw',
      allowAutopilot: true,
      discovery: {
        connectorName: 'openclaw',
        externalId: 'test',
        state: 'available'
      }
    });
    expect(
      peerSchema.parse({
        id: 'peer_000000000001',
        label: 'Build host',
        baseUrl: 'https://build.example.com/openai',
        credential: { token: 'peer-token' }
      })
    ).toMatchObject({ label: 'Build host', defaultAgent: 'default', enabled: false });
    expect(monadixConfigSchema.parse({})).toEqual({ enabled: false });
  });

  test('config owns system entry points and composes the root contract', async () => {
    const { channelInstanceSchema, createDefaultConfig, logAutoCleanupSchema, monadConfigSchema } = await import(
      '../../src/config/config.ts'
    );
    expect(
      channelInstanceSchema.parse({
        id: 'chn_000000000001',
        type: 'telegram',
        label: 'Telegram',
        credential: { token: 'channel-token' }
      })
    ).toMatchObject({ label: 'Telegram', enabled: true, rateLimitPerMin: 20 });
    const retiredAllowlist = channelInstanceSchema.safeParse({
      id: 'chn_000000000002',
      type: 'telegram',
      label: 'Retired allowlist',
      allowlist: { policy: 'pairing', allowAllUsers: false, allowedUsers: ['123'] }
    });
    expect(retiredAllowlist.success).toBe(false);
    expect(retiredAllowlist.error?.issues.map((issue) => [issue.code, issue.path.join('.')])).toEqual([
      ['unrecognized_keys', '']
    ]);
    expect(
      channelInstanceSchema.parse({
        id: 'chn_000000000003',
        type: 'whatsapp',
        label: 'Legacy WhatsApp Cloud API',
        options: { phoneNumberId: '123456' },
        credential: { token: 'cloud-token' }
      } as unknown)
    ).toEqual({
      id: 'chn_000000000003',
      type: 'whatsapp-business',
      label: 'Legacy WhatsApp Cloud API',
      enabled: true,
      mapping: { granularity: 'per-conversation' },
      credential: { token: 'cloud-token', extra: { phoneNumberId: '123456' } },
      rateLimitPerMin: 20
    });

    const config = monadConfigSchema.parse(createDefaultConfig('Operator'));
    expect(config.user).toEqual({ displayName: 'Operator', avatarDataUrl: null });
    expect(config.agent.agents).toEqual([]);
    expect(config.channels).toEqual([]);
    expect(config.meshAgents).toEqual([]);
    expect(logAutoCleanupSchema.parse({})).toEqual({ enabled: true, retentionDays: 14 });
  });
});
