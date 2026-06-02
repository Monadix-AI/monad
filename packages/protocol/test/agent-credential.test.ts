import { describe, expect, test } from 'bun:test';

import {
  agentCredentialHostSchema,
  createAgentCredentialRequestSchema,
  createAgentRequestSchema,
  getAgentCredentialResponseSchema,
  getAgentResponseSchema,
  listAgentCredentialsResponseSchema,
  listAgentsResponseSchema,
  updateAgentCredentialRequestSchema,
  updateAgentRequestSchema
} from '../src/index.ts';

const view = {
  id: 'credential-stable-id',
  label: 'GitHub',
  description: 'API access',
  environmentVariable: 'GITHUB_TOKEN',
  allowedHosts: ['api.github.com'],
  configured: false,
  authorizedAgentIds: ['agt_test00000000' as const]
};

describe('Agent Credential wire contracts', () => {
  test('host validation normalizes DNS hostnames without a Node runtime dependency', () => {
    expect(agentCredentialHostSchema.parse('API.GitHub.com')).toBe('api.github.com');
    expect(agentCredentialHostSchema.parse('bücher.example')).toBe('xn--bcher-kva.example');
  });

  test.each([
    '127.0.0.1',
    '192.168.1.1',
    '::1',
    '[::1]',
    '2130706433',
    '0x7f000001',
    '127.1',
    '0177.0.0.1',
    '0x7f.0.0.1'
  ])('host validation rejects canonical and obscured IP form %s', (host) => {
    expect(agentCredentialHostSchema.safeParse(host).success).toBe(false);
  });

  test('list/get accept the exact redacted view, including a removed value as configured false', () => {
    expect(listAgentCredentialsResponseSchema.parse({ credentials: [view] })).toEqual({ credentials: [view] });
    expect(getAgentCredentialResponseSchema.parse({ credential: view })).toEqual({ credential: view });
  });

  test.each(['secret', 'preview', 'fingerprint', 'createdAt', 'updatedAt'])(
    'read views reject secret-derived field %s',
    (field) => {
      expect(getAgentCredentialResponseSchema.safeParse({ credential: { ...view, [field]: 'canary' } }).success).toBe(
        false
      );
    }
  );

  test('create requires a secret and normalizes allowed hosts', () => {
    const request = {
      label: 'GitHub',
      environmentVariable: 'GITHUB_TOKEN',
      secret: 'canary',
      allowedHosts: ['API.GitHub.com']
    };
    expect(createAgentCredentialRequestSchema.parse(request)).toEqual({
      ...request,
      allowedHosts: ['api.github.com']
    });
    const { secret: _, ...withoutSecret } = request;
    expect(createAgentCredentialRequestSchema.safeParse(withoutSecret).success).toBe(false);
  });

  test('update distinguishes metadata-only, replace, and remove', () => {
    expect(updateAgentCredentialRequestSchema.parse({ label: 'Renamed' })).toEqual({ label: 'Renamed' });
    expect(updateAgentCredentialRequestSchema.parse({ secret: { action: 'replace', value: 'new-secret' } })).toEqual({
      secret: { action: 'replace', value: 'new-secret' }
    });
    expect(updateAgentCredentialRequestSchema.parse({ secret: { action: 'remove' } })).toEqual({
      secret: { action: 'remove' }
    });
  });
});

describe('agent grant wire shapes', () => {
  const agent = {
    id: 'agt_test00000000' as const,
    name: 'Test',
    credentialIds: [],
    capabilities: [],
    declaredScopes: [],
    memory: { enabled: true, advanced: true, autoConsolidate: false, intervalMinutes: 30 },
    visibility: { subagentCallable: false, public: false },
    a2a: { enabled: false },
    monadix: { consume: false }
  };

  test('create defaults credentialIds and update preserves an explicit grant list', () => {
    expect(createAgentRequestSchema.parse({ name: 'Test' }).credentialIds).toEqual([]);
    expect(updateAgentRequestSchema.parse({ credentialIds: ['credential-stable-id'] })).toEqual({
      credentialIds: ['credential-stable-id']
    });
  });

  test('get/list return exact agent shapes with credentialIds', () => {
    expect(getAgentResponseSchema.parse({ agent })).toEqual({ agent });
    expect(listAgentsResponseSchema.parse({ agents: [agent] })).toEqual({ agents: [agent] });
  });
});
