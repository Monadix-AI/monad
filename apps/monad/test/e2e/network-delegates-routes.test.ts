// e2e: two newer HTTP surfaces that previously lacked any transport coverage —
//   GET/PUT /v1/settings/network  (remote access + local HTTP fallback lifecycle)
//   GET     /v1/sessions/:id/delegates  (ACP delegate ledger)
// Both must behave identically over TCP loopback and the Unix socket (docs/internals/infra/runtime.md).

import type { MonadPaths } from '@monad/environment';
import type { NetworkSettings } from '@monad/protocol';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initMonadHome, loadConfig } from '@monad/environment';
import { httpErrorSchema } from '@monad/protocol';

import { createHttpTransport } from '#/transports/http.ts';
import {
  buildHandlers,
  makeTestPaths,
  mockModel,
  serveTransport,
  stubModelDeps,
  TRANSPORTS,
  type TransportHandle
} from '../helpers.ts';

for (const kind of TRANSPORTS) {
  describe(`network + delegates routes over ${kind}`, () => {
    let dir: string;
    let paths: MonadPaths;
    let t: TransportHandle;
    let handlers: ReturnType<typeof buildHandlers>;

    beforeEach(async () => {
      dir = join(tmpdir(), `monad-netdel-${Date.now()}-${process.hrtime.bigint()}`);
      paths = makeTestPaths(dir);
      await initMonadHome(paths);
      const cfg = await loadConfig(paths);
      if (!cfg) throw new Error('config missing after init');
      handlers = buildHandlers(mockModel(), { ...stubModelDeps(), paths });
      t = serveTransport(kind, createHttpTransport(handlers));
    });

    afterEach(async () => {
      await t.stop();
      await rm(dir, { recursive: true, force: true });
    });

    const json = (method: string, path: string, body?: unknown) =>
      t.fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });

    test('network settings default to loopback HTTP with remote access disabled', async () => {
      const settings = (await (await json('GET', '/v1/settings/network')).json()) as NetworkSettings;
      expect(settings).toMatchObject({
        host: '127.0.0.1',
        https: { enabled: false },
        localHttpFallback: { enabled: false, port: 47780 },
        remoteAccess: { enabled: false, token: null }
      });
    });

    test('network host accepts loopback updates independently of protocol and ports', async () => {
      const updated = (await (
        await json('PUT', '/v1/settings/network', { host: 'localhost' })
      ).json()) as NetworkSettings;
      expect(updated.host).toBe('localhost');
      expect(updated.https.enabled).toBe(false);
      expect(updated.localHttpFallback).toEqual({ enabled: false, port: 47780 });

      const persisted = (await (await json('GET', '/v1/settings/network')).json()) as NetworkSettings;
      expect(persisted.host).toBe('localhost');
    });

    test('network host rejects non-loopback updates while remote access is disabled', async () => {
      const res = await json('PUT', '/v1/settings/network', { host: '0.0.0.0' });
      expect(res.status).toBe(400);
      expect(httpErrorSchema.parse(await res.json())).toEqual({
        error: 'request validation failed',
        code: 'VALIDATION',
        retryable: false,
        requestId: expect.stringMatching(/^req_[0-9a-zA-Z]{12}$/),
        details: { issues: ['request validation failed'] }
      });
    });

    test('network host accepts non-loopback updates when remote access is enabled', async () => {
      const updated = (await (
        await json('PUT', '/v1/settings/network', { remoteAccess: { enabled: true }, host: '192.168.1.20' })
      ).json()) as NetworkSettings;
      expect(updated.remoteAccess.enabled).toBe(true);
      expect(updated.host).toBe('192.168.1.20');
    });

    test('disabling remote access returns an explicit non-loopback host to loopback', async () => {
      await json('PUT', '/v1/settings/network', { remoteAccess: { enabled: true }, host: '192.168.1.20' });
      const disabled = (await (
        await json('PUT', '/v1/settings/network', { remoteAccess: { enabled: false } })
      ).json()) as NetworkSettings;
      expect(disabled.remoteAccess.enabled).toBe(false);
      expect(disabled.host).toBe('127.0.0.1');
    });

    test('enabling remote access mints a token; disabling clears it', async () => {
      const enabled = (await (
        await json('PUT', '/v1/settings/network', { remoteAccess: { enabled: true } })
      ).json()) as NetworkSettings;
      expect(enabled.remoteAccess.enabled).toBe(true);
      expect(enabled.remoteAccess.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(enabled.restartRequired).toBe(false);

      // Persisted, not just echoed.
      const persisted = (await (await json('GET', '/v1/settings/network')).json()) as NetworkSettings;
      expect(persisted.remoteAccess.token).toBe(enabled.remoteAccess.token);

      const disabled = (await (
        await json('PUT', '/v1/settings/network', { remoteAccess: { enabled: false } })
      ).json()) as NetworkSettings;
      expect(disabled.remoteAccess.enabled).toBe(false);
      expect(disabled.remoteAccess.token).toBeNull();
    });

    test('rotateToken issues a fresh token while remote stays enabled', async () => {
      const first = (await (
        await json('PUT', '/v1/settings/network', { remoteAccess: { enabled: true } })
      ).json()) as NetworkSettings;
      const rotated = (await (
        await json('PUT', '/v1/settings/network', { remoteAccess: { rotateToken: true } })
      ).json()) as NetworkSettings;
      expect(rotated.remoteAccess.enabled).toBe(true);
      expect(rotated.remoteAccess.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(rotated.remoteAccess.token).not.toBe(first.remoteAccess.token);
    });

    test('localHttpFallback toggles independently of remote access', async () => {
      const out = (await (
        await json('PUT', '/v1/settings/network', { localHttpFallback: { enabled: true, port: 53001 } })
      ).json()) as NetworkSettings;
      expect(out.localHttpFallback).toEqual({ enabled: true, port: 53001 });
      expect(out.remoteAccess.enabled).toBe(false); // untouched
    });

    test('https can be explicitly disabled as a global fallback switch', async () => {
      const out = (await (
        await json('PUT', '/v1/settings/network', { https: { enabled: false } })
      ).json()) as NetworkSettings;
      expect(out.https.enabled).toBe(false);
      expect(out.remoteAccess.enabled).toBe(false);
    });

    test('remote HTTP requires acknowledgment and preserves remote access after confirmation', async () => {
      await json('PUT', '/v1/settings/network', { remoteAccess: { enabled: true } });
      const res = await json('PUT', '/v1/settings/network', { https: { enabled: false } });
      expect(res.status).toBe(400);
      expect(httpErrorSchema.parse(await res.json())).toEqual({
        error: 'request validation failed',
        code: 'VALIDATION',
        retryable: false,
        requestId: expect.stringMatching(/^req_[0-9a-zA-Z]{12}$/),
        details: { issues: ['request validation failed'] }
      });

      const confirmed = (await (
        await json('PUT', '/v1/settings/network', {
          confirmInsecureRemoteAccess: true,
          https: { enabled: false }
        })
      ).json()) as NetworkSettings;
      expect(confirmed).toMatchObject({
        https: { enabled: false },
        remoteAccess: { enabled: true, token: expect.any(String) }
      });
    });

    test('health reports certificate status as disabled when HTTPS is off', async () => {
      await json('PUT', '/v1/settings/network', { https: { enabled: false } });
      const health = (await (await json('GET', '/health')).json()) as { certStatus?: string; warnings?: string[] };
      expect(health.certStatus).toBe('disabled');
      expect(health.warnings ?? []).toContain('tls:https-disabled');
    });

    test('lists ACP delegate ledger rows for a session, newest first', async () => {
      const created = await json('POST', '/v1/sessions', { title: 'deleg' });
      const { sessionId } = (await created.json()) as { sessionId: string };

      handlers.store.upsertAcpDelegate({
        id: `${sessionId} codex`,
        sessionId,
        agentName: 'codex',
        acpSessionId: 'acp-1',
        pid: 1234,
        spawnedAt: '2026-06-26T10:00:00.000Z',
        lastUsedAt: '2026-06-26T10:00:00.000Z'
      });
      handlers.store.upsertAcpDelegate({
        id: `${sessionId} gemini`,
        sessionId,
        agentName: 'gemini',
        acpSessionId: 'acp-2',
        pid: 5678,
        spawnedAt: '2026-06-26T11:00:00.000Z',
        lastUsedAt: '2026-06-26T11:00:00.000Z'
      });

      const res = await json('GET', `/v1/sessions/${sessionId}/delegates`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { delegates: Array<{ agentName: string; pid: number }> };
      expect(body.delegates.map((d) => d.agentName)).toEqual(['gemini', 'codex']); // newest first
    });

    test('delegates honours the limit query param', async () => {
      const created = await json('POST', '/v1/sessions', { title: 'deleg-limit' });
      const { sessionId } = (await created.json()) as { sessionId: string };
      for (let i = 0; i < 3; i++) {
        handlers.store.upsertAcpDelegate({
          id: `${sessionId} a${i}`,
          sessionId,
          agentName: `a${i}`,
          acpSessionId: `acp-${i}`,
          pid: 1000 + i,
          spawnedAt: `2026-06-26T1${i}:00:00.000Z`,
          lastUsedAt: `2026-06-26T1${i}:00:00.000Z`
        });
      }
      const res = await json('GET', `/v1/sessions/${sessionId}/delegates?limit=2`);
      const body = (await res.json()) as { delegates: unknown[] };
      expect(body.delegates).toHaveLength(2);
    });
  });
}
