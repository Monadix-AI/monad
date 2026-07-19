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
    expect(agentConfigSchema.parse({ id: 'agt_000000000001', name: 'Default' })).toMatchObject({
      name: 'Default',
      capabilities: [],
      declaredScopes: []
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
    expect(memorySettingsSchema.parse({})).toEqual({ backend: 'builtin', level: 1, mem0: {} });
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
    expect(meshAgentSchema.parse({ name: 'codex', provider: 'codex', command: 'codex', enabled: true })).toMatchObject({
      name: 'codex',
      provider: 'codex',
      allowAutopilot: true
    });
    expect(
      peerSchema.parse({
        id: 'peer_000000000001',
        label: 'Build host',
        baseUrl: 'https://build.example.com/openai',
        tokenRef: 'peer-token-ref'
      })
    ).toMatchObject({ label: 'Build host', defaultAgent: 'default', enabled: false });
    expect(monadixConfigSchema.parse({})).toEqual({ enabled: false });
  });

  test('config owns system entry points and composes the root contract', async () => {
    const { channelInstanceSchema, createDefaultConfig, monadConfigSchema } = await import(
      '../../src/config/config.ts'
    );
    expect(
      channelInstanceSchema.parse({
        id: 'chn_000000000001',
        type: 'telegram',
        label: 'Telegram',
        tokenRef: 'channel-token-ref'
      })
    ).toMatchObject({ label: 'Telegram', enabled: true, rateLimitPerMin: 20 });

    const config = monadConfigSchema.parse(createDefaultConfig('Operator'));
    expect(config.user).toEqual({ displayName: 'Operator', avatarDataUrl: null });
    expect(config.agent.agents).toEqual([]);
    expect(config.channels).toEqual([]);
    expect(config.meshAgents).toEqual([]);
  });
});
