import { describe, expect, test } from 'bun:test';

import { agentConfigSchema, monadAuthSchema, sandboxConfigSchema } from '../../src/config/index.ts';

const timestamp = '2026-07-29T00:00:00.000Z';

function vault() {
  return {
    version: 1,
    updatedAt: timestamp,
    credentials: {
      'credential-stable-id': {
        label: 'GitHub',
        description: 'API access',
        environmentVariable: 'GITHUB_TOKEN',
        secret: 'canary-secret',
        allowedHosts: ['API.GitHub.com', 'bücher.example'],
        createdAt: timestamp,
        updatedAt: timestamp
      }
    }
  };
}

describe('auth.json v1 Agent Credential vault', () => {
  test('parses the exact vault and normalizes hostnames without changing stable identity or timestamps', () => {
    expect(monadAuthSchema.parse(vault())).toEqual({
      version: 1,
      updatedAt: timestamp,
      credentials: {
        'credential-stable-id': {
          label: 'GitHub',
          description: 'API access',
          environmentVariable: 'GITHUB_TOKEN',
          secret: 'canary-secret',
          allowedHosts: ['api.github.com', 'xn--bcher-kva.example'],
          createdAt: timestamp,
          updatedAt: timestamp
        }
      }
    });
  });

  test.each([
    'activeProvider',
    'credentialPool',
    'mcpOAuth',
    'channelCredentials',
    'peerCredentials',
    'atomRegistries',
    'namedSecrets'
  ])('rejects removed legacy field %s', (field) => {
    expect(monadAuthSchema.safeParse({ ...vault(), [field]: {} }).success).toBe(false);
  });

  test('rejects a non-current vault version and an empty allowed-host list', () => {
    expect(monadAuthSchema.safeParse({ ...vault(), version: 2 }).success).toBe(false);
    const raw = vault();
    raw.credentials['credential-stable-id'].allowedHosts = [];
    expect(monadAuthSchema.safeParse(raw).success).toBe(false);
  });

  test.each([
    'https://api.github.com',
    'api.github.com/path',
    'user@api.github.com',
    '*.github.com',
    'api.github.com:443',
    '127.1',
    '0x7f000001'
  ])('rejects non-host or IP-obscuring input %s', (host) => {
    const raw = vault();
    raw.credentials['credential-stable-id'].allowedHosts = [host];
    expect(monadAuthSchema.safeParse(raw).success).toBe(false);
  });
});

describe('agent credential grants', () => {
  test('defaults credentialIds and rejects the removed global sandbox credential fields', () => {
    const agent = agentConfigSchema.parse({
      id: 'agt_test00000000',
      name: 'Test',
      memory: { enabled: true, advanced: true, autoConsolidate: false, intervalMinutes: 30 }
    });
    expect(agent.credentialIds).toEqual([]);
    expect(sandboxConfigSchema.safeParse({ credentials: [] }).success).toBe(false);
    expect(sandboxConfigSchema.safeParse({ credential: 'legacy' }).success).toBe(false);
  });
});
