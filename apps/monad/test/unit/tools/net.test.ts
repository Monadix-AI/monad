import type { ToolContext } from '@/capabilities/tools/types.ts';

import { afterEach, expect, test } from 'bun:test';

import { configureSandboxNet, netFetchTool, ToolSecurityError } from '@/capabilities/tools';
import { createApprovalFetch, fetchTextSafe } from '@/capabilities/tools/registry/net.ts';

// These assert the SSRF guards reject without ever opening a socket — no network needed.
const ctx: ToolContext = { sessionId: 's1', sandboxRoots: undefined, log: () => {} };

afterEach(() => configureSandboxNet('unrestricted'));

test('net_fetch input schema rejects non-http(s) URLs', () => {
  expect(netFetchTool.inputSchema?.safeParse({ url: 'https://example.com/' }).success).toBe(true);
  expect(netFetchTool.inputSchema?.safeParse({ url: 'file:///etc/passwd' }).success).toBe(false);
});

test('net_fetch rejects non-http(s) schemes', async () => {
  await expect(netFetchTool.run({ url: 'file:///etc/passwd' }, ctx)).rejects.toBeInstanceOf(ToolSecurityError);
});

test('net_fetch rejects loopback by name', async () => {
  await expect(netFetchTool.run({ url: 'http://localhost:8080/' }, ctx)).rejects.toBeInstanceOf(ToolSecurityError);
});

test('net_fetch rejects a private IP literal', async () => {
  await expect(netFetchTool.run({ url: 'http://127.0.0.1/' }, ctx)).rejects.toBeInstanceOf(ToolSecurityError);
});

test('net_fetch rejects the cloud-metadata address', async () => {
  await expect(netFetchTool.run({ url: 'http://169.254.169.254/latest/meta-data/' }, ctx)).rejects.toBeInstanceOf(
    ToolSecurityError
  );
});

test('net_fetch requests network_access keyed by hostname before fetching', async () => {
  configureSandboxNet('none');
  const calls: Array<{ tool: string; key?: string; input: unknown }> = [];
  const gatedCtx: ToolContext = {
    ...ctx,
    gate: async (req) => {
      calls.push({ tool: req.tool, key: req.key, input: req.input });
      return { allow: false, reason: 'test deny' };
    }
  };

  await expect(netFetchTool.run({ url: 'https://example.com/docs' }, gatedCtx)).rejects.toBeInstanceOf(
    ToolSecurityError
  );
  expect(calls).toEqual([
    {
      tool: 'network_access',
      key: 'example.com',
      input: {
        url: 'https://example.com/docs',
        host: 'example.com',
        protocol: 'https',
        defaultScope: 'session',
        rememberScopes: ['once', 'session', 'agent', 'global'],
        reason: 'net_fetch',
        displayHint: {
          kind: 'resource-approval',
          resource: 'network',
          subject: 'example.com',
          defaultScope: 'session',
          rememberScopes: ['once', 'session', 'agent', 'global']
        }
      }
    }
  ]);
});

test('net_fetch skips network_access when unrestricted and not sandbox-scoped', async () => {
  configureSandboxNet('unrestricted');
  const calls: unknown[] = [];
  const gatedCtx: ToolContext = {
    ...ctx,
    gate: async (req) => {
      calls.push(req);
      return { allow: false, reason: 'should not be called' };
    }
  };

  await expect(netFetchTool.run({ url: 'https://example.invalid/', timeoutMs: 1 }, gatedCtx)).rejects.toThrow();
  expect(calls).toHaveLength(0);
});

test('createApprovalFetch gates the actual provider request URL before calling fetch', async () => {
  configureSandboxNet('none');
  const calls: Array<{ tool: string; key?: string }> = [];
  const gatedCtx: ToolContext = {
    ...ctx,
    gate: async (req) => {
      calls.push({ tool: req.tool, key: req.key });
      return { allow: false, reason: 'deny before fetch' };
    }
  };
  let fetched = false;
  const fetchImpl = (async () => {
    fetched = true;
    return new Response('nope');
  }) as unknown as typeof fetch;

  await expect(
    createApprovalFetch(gatedCtx, { reason: 'web_search', fetchImpl })('https://api.search.brave.com/res/v1/web/search')
  ).rejects.toBeInstanceOf(ToolSecurityError);
  expect(fetched).toBe(false);
  expect(calls).toEqual([{ tool: 'network_access', key: 'api.search.brave.com' }]);
});

test('net_fetch requests network_access when sandbox-scoped even with unrestricted net', async () => {
  configureSandboxNet('unrestricted');
  const calls: Array<{ tool: string; key?: string }> = [];
  const gatedCtx: ToolContext = {
    ...ctx,
    sandboxRoots: ['/sandbox'],
    gate: async (req) => {
      calls.push({ tool: req.tool, key: req.key });
      return { allow: false, reason: 'test deny' };
    }
  };

  await expect(netFetchTool.run({ url: 'https://Example.COM./docs' }, gatedCtx)).rejects.toBeInstanceOf(
    ToolSecurityError
  );
  expect(calls).toEqual([{ tool: 'network_access', key: 'example.com' }]);
});

test('fetchTextSafe skips duplicate network_access for an already approved host', async () => {
  configureSandboxNet('none');
  const calls: unknown[] = [];
  const gatedCtx: ToolContext = {
    ...ctx,
    gate: async (req) => {
      calls.push(req);
      return { allow: false, reason: 'should not be called' };
    }
  };

  await expect(
    fetchTextSafe('https://example.invalid/', {
      timeoutMs: 1,
      approval: { ctx: gatedCtx, reason: 'test' },
      approvedHosts: new Set(['example.invalid'])
    })
  ).rejects.toThrow();
  expect(calls).toHaveLength(0);
});
