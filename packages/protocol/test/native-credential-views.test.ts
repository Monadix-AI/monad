import { describe, expect, test } from 'bun:test';

import {
  atomRegistriesUpdateSchema,
  atomRegistriesViewSchema,
  getMcpServerResponseSchema,
  getPeerResponseSchema,
  nativeCredentialConfiguredViewSchema,
  setPeerCredentialRequestSchema,
  setSandboxSettingsRequestSchema,
  setToolBackendsRequestSchema,
  toolBackendsResponseSchema,
  upsertMcpServerRequestSchema
} from '../src/index.ts';

const canary = 'native-canary-secret';

describe('native credential read views', () => {
  test('MCP bearer credentials expose configured state only', () => {
    const response = {
      server: {
        name: 'remote',
        transport: 'http' as const,
        url: 'https://mcp.example.com',
        auth: { mode: 'bearer' as const, token: { configured: true } },
        enabled: true,
        trust: { autoApproveTools: [], hostEscape: false }
      }
    };
    expect(getMcpServerResponseSchema.parse(response)).toEqual(response);
    expect(
      getMcpServerResponseSchema.safeParse({
        server: { ...response.server, auth: { mode: 'bearer', token: canary } }
      }).success
    ).toBe(false);
  });

  test('peer and registry views reject raw secret leaves', () => {
    const peer = {
      peer: {
        id: 'peer_HOME00000000' as const,
        label: 'Home',
        baseUrl: 'https://peer.example.com/openai',
        defaultAgent: 'default',
        credentialConfigured: true,
        enabled: true
      }
    };
    expect(getPeerResponseSchema.parse(peer)).toEqual(peer);
    expect(getPeerResponseSchema.safeParse({ peer: { ...peer.peer, token: canary } }).success).toBe(false);

    expect(atomRegistriesViewSchema.parse({ github: { token: { configured: true } } })).toEqual({
      github: { token: { configured: true } }
    });
    expect(atomRegistriesViewSchema.safeParse({ github: { token: canary } }).success).toBe(false);
  });

  test('sandbox-backend configured state is a strict non-secret leaf', () => {
    expect(nativeCredentialConfiguredViewSchema.parse({ configured: true })).toEqual({ configured: true });
    expect(nativeCredentialConfiguredViewSchema.safeParse({ configured: true, value: canary }).success).toBe(false);
  });

  test('tool-backend views expose configured state for every native secret', () => {
    const response = {
      webSearch: { provider: 'brave' as const, braveApiKey: { configured: true } },
      email: {
        backend: 'smtp' as const,
        resendApiKey: { configured: true },
        smtp: { host: 'smtp.example.com', pass: { configured: true } }
      },
      codeExec: {
        backend: 'e2b',
        availableBackends: ['follow-system', 'e2b'],
        e2bApiKey: { configured: true }
      }
    };
    expect(toolBackendsResponseSchema.parse(response)).toEqual(response);
    expect(
      toolBackendsResponseSchema.safeParse({
        ...response,
        webSearch: { ...response.webSearch, braveApiKey: canary }
      }).success
    ).toBe(false);
  });
});

describe('native credential mutation operations', () => {
  test('MCP, peer, registry, and sandbox mutations distinguish replace and remove', () => {
    const parsedMcp = upsertMcpServerRequestSchema.parse({
      server: {
        name: 'remote',
        transport: 'http',
        url: 'https://mcp.example.com',
        auth: { mode: 'bearer', token: { action: 'replace', value: canary } },
        enabled: true,
        trust: { autoApproveTools: [], hostEscape: false }
      }
    });
    expect(parsedMcp.server.transport === 'http' ? parsedMcp.server.auth : undefined).toEqual({
      mode: 'bearer',
      token: { action: 'replace', value: canary }
    });
    expect(setPeerCredentialRequestSchema.parse({ action: 'remove' })).toEqual({ action: 'remove' });
    expect(atomRegistriesUpdateSchema.parse({ github: { token: { action: 'remove' } } })).toEqual({
      github: { token: { action: 'remove' } }
    });
    expect(
      setSandboxSettingsRequestSchema.parse({
        backendSettings: {
          ref: { source: 'builtin', kind: 'e2b' },
          secrets: { apiKey: { action: 'replace', value: canary } }
        }
      }).backendSettings?.secrets
    ).toEqual({ apiKey: { action: 'replace', value: canary } });
    expect(
      setToolBackendsRequestSchema.parse({
        webSearch: { braveApiKey: { action: 'replace', value: canary } },
        email: {
          resendApiKey: { action: 'remove' },
          smtp: {
            action: 'replace',
            value: { host: 'smtp.example.com', pass: { action: 'remove' } }
          }
        },
        codeExec: { e2bApiKey: { action: 'remove' } }
      })
    ).toEqual({
      webSearch: { braveApiKey: { action: 'replace', value: canary } },
      email: {
        resendApiKey: { action: 'remove' },
        smtp: {
          action: 'replace',
          value: { host: 'smtp.example.com', pass: { action: 'remove' } }
        }
      },
      codeExec: { e2bApiKey: { action: 'remove' } }
    });
  });

  test('native credential mutations reject removed secret-reference syntax', () => {
    expect(
      setToolBackendsRequestSchema.safeParse({
        webSearch: {
          // biome-ignore lint/suspicious/noTemplateCurlyInString: rejection test uses the literal legacy syntax
          braveApiKey: { action: 'replace', value: '${secret:brave}' }
        }
      }).success
    ).toBe(false);
  });
});
