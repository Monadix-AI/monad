import type { ToolContext } from '@/capabilities/tools/types.ts';

import { expect, test } from 'bun:test';

import { netFetchTool, ToolSecurityError } from '@/capabilities/tools';

// These assert the SSRF guards reject without ever opening a socket — no network needed.
const ctx: ToolContext = { sessionId: 's1', sandboxRoots: undefined, log: () => {} };

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
