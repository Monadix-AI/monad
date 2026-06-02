// Peer settings CRUD over a real temp ~/.monad: upsert → list (no secret) → set credential
// (writes mesh.json + enables) → update (preserves credential) → disable → remove. Exercises
// the settings module (modules/settings/peer) the same way the HTTP controller + CLI drive it.

import type { MonadPaths } from '@monad/environment';
import type { PeerView, UpsertPeerRequest } from '@monad/protocol';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initMonadHome, loadAll, loadAuth, saveAgents } from '@monad/environment';

import { ModelService } from '#/handlers/settings/model/index.ts';
import { createHttpTransport } from '#/transports/http.ts';
import {
  buildHandlers,
  makeTestPaths,
  mockModel,
  seededProviderRegistry,
  serveTransport,
  TRANSPORTS
} from '../helpers.ts';

function makePaths(base: string): MonadPaths {
  return makeTestPaths(base, { mcp: join(base, 'atoms', 'mcp'), skillsLock: join(base, 'atoms', 'skills.lock') });
}

let dir: string;
let paths: MonadPaths;
let handlers: ReturnType<typeof buildHandlers>;

beforeEach(async () => {
  dir = join(tmpdir(), `monad-peersettings-${process.pid}-${Date.now()}-${process.hrtime.bigint()}`);
  paths = makePaths(dir);
  await initMonadHome(paths);
  const cfg = await loadAll(paths);
  if (!cfg) throw new Error('config missing');
  const modelService = new ModelService(paths.auth, cfg, await loadAuth(paths.auth), seededProviderRegistry());
  handlers = buildHandlers(mockModel(), { paths, modelService });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

type PeerWrite = UpsertPeerRequest['peer'];

const view = (over: Partial<PeerWrite> = {}): PeerWrite => ({
  id: 'peer_HOME00000000' as PeerView['id'],
  label: 'home',
  baseUrl: 'https://home.example:52749/openai',
  defaultAgent: 'default',
  enabled: false,
  ...over
});

for (const kind of TRANSPORTS) {
  describe(`peer credential settings over ${kind}`, () => {
    test('replace, overwrite, and remove retain the peer with redacted configured state', async () => {
      const base = join(tmpdir(), `monad-peertransport-${kind}-${Date.now()}-${process.hrtime.bigint()}`);
      const transportPaths = makePaths(base);
      await initMonadHome(transportPaths);
      const cfg = await loadAll(transportPaths);
      if (!cfg) throw new Error('config missing');
      const modelService = new ModelService(
        transportPaths.auth,
        cfg,
        await loadAuth(transportPaths.auth),
        seededProviderRegistry()
      );
      const transport = serveTransport(
        kind,
        createHttpTransport(buildHandlers(mockModel(), { paths: transportPaths, modelService }))
      );
      const request = (method: string, path: string, body?: unknown) =>
        transport.fetch(path, {
          method,
          headers: { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body)
        });

      try {
        expect((await request('PUT', '/v1/settings/peers', { peer: view() })).status).toBe(200);
        let response = await request('GET', '/v1/settings/peers/peer_HOME00000000');
        expect(((await response.json()) as { peer: PeerView }).peer).toMatchObject({
          id: 'peer_HOME00000000',
          label: 'home',
          credentialConfigured: false
        });

        expect(
          (
            await request('PUT', '/v1/settings/peers/peer_HOME00000000/credential', {
              action: 'replace',
              value: 'peer-first-canary'
            })
          ).status
        ).toBe(200);
        response = await request('GET', '/v1/settings/peers/peer_HOME00000000');
        const configured = ((await response.json()) as { peer: PeerView }).peer;
        expect(configured).toMatchObject({
          id: 'peer_HOME00000000',
          label: 'home',
          credentialConfigured: true,
          enabled: true
        });
        expect(JSON.stringify(configured)).not.toContain('peer-first-canary');
        expect((await loadAll(transportPaths))?.peers[0]?.credential?.token).toBe('peer-first-canary');

        expect(
          (
            await request('PUT', '/v1/settings/peers/peer_HOME00000000/credential', {
              action: 'replace',
              value: 'peer-second-canary'
            })
          ).status
        ).toBe(200);
        expect((await loadAll(transportPaths))?.peers[0]?.credential?.token).toBe('peer-second-canary');

        expect(
          (
            await request('PUT', '/v1/settings/peers/peer_HOME00000000/credential', {
              action: 'remove'
            })
          ).status
        ).toBe(200);
        response = await request('GET', '/v1/settings/peers/peer_HOME00000000');
        const removed = ((await response.json()) as { peer: PeerView }).peer;
        expect(removed).toMatchObject({
          id: 'peer_HOME00000000',
          label: 'home',
          credentialConfigured: false,
          enabled: true
        });
        expect((await loadAll(transportPaths))?.peers[0]).toMatchObject({
          id: 'peer_HOME00000000',
          label: 'home'
        });
        expect((await loadAll(transportPaths))?.peers[0]?.credential).toBeUndefined();
        expect((await loadAuth(transportPaths.auth))?.credentials).toEqual({});
      } finally {
        await transport.stop();
        await rm(base, { recursive: true, force: true });
      }
    });
  });
}

test('upsert → list returns the peer without any secret material', async () => {
  await handlers.peer.upsertPeer({ peer: view() });
  const { peers } = await handlers.peer.listPeers();
  expect(peers).toHaveLength(1);
  expect(peers[0]).toMatchObject({ id: 'peer_HOME00000000', label: 'home', enabled: false });
  expect(JSON.stringify(peers[0])).not.toContain('secret');
  expect(JSON.stringify(peers[0])).not.toContain('token');
  const cfg = await loadAll(paths);
  expect(cfg?.peers[0]?.credential).toBeUndefined();
  expect(peers[0]?.credentialConfigured).toBe(false);
});

test('setPeerCredential stores the token in mesh.json and enables the peer', async () => {
  await handlers.peer.upsertPeer({ peer: view() });
  await handlers.peer.setPeerCredential({ id: 'peer_HOME00000000', action: 'replace', value: 'the-token' });
  const cfg = await loadAll(paths);
  expect(cfg?.peers[0]?.credential).toEqual({ token: 'the-token' });
  const auth = await loadAuth(paths.auth);
  expect(auth?.credentials).toEqual({});
  const { peers } = await handlers.peer.listPeers();
  expect(peers[0]).toMatchObject({ enabled: true, credentialConfigured: true });
});

test('updating a peer preserves its existing credential', async () => {
  await handlers.peer.upsertPeer({ peer: view() });
  await handlers.peer.setPeerCredential({ id: 'peer_HOME00000000', action: 'replace', value: 'the-token' });
  await handlers.peer.upsertPeer({ peer: view({ label: 'renamed', baseUrl: 'https://new.example/openai' }) });
  const { peers } = await handlers.peer.listPeers();
  expect(peers).toHaveLength(1);
  expect(peers[0]).toMatchObject({ label: 'renamed', baseUrl: 'https://new.example/openai' });
  const cfg = await loadAll(paths);
  expect(cfg?.peers[0]?.credential).toEqual({ token: 'the-token' });
});

test('enable/disable toggles the stored flag', async () => {
  await handlers.peer.upsertPeer({ peer: view({ enabled: true }) });
  await handlers.peer.setPeerEnabled({ id: 'peer_HOME00000000', enabled: false });
  let { peers } = await handlers.peer.listPeers();
  expect(peers[0]?.enabled).toBe(false);
  await handlers.peer.setPeerEnabled({ id: 'peer_HOME00000000', enabled: true });
  ({ peers } = await handlers.peer.listPeers());
  expect(peers[0]?.enabled).toBe(true);
});

test('remove drops the peer without changing auth.json', async () => {
  await handlers.peer.upsertPeer({ peer: view() });
  await handlers.peer.setPeerCredential({ id: 'peer_HOME00000000', action: 'replace', value: 'the-token' });
  await handlers.peer.removePeer({ id: 'peer_HOME00000000' });
  const { peers } = await handlers.peer.listPeers();
  expect(peers).toHaveLength(0);
  const auth = await loadAuth(paths.auth);
  expect(auth?.credentials).toEqual({});
});

// A peer mutation writes mesh.json and must leave the independent agents.json policy untouched.
test('a peer mutation preserves the operator agent.approvals policy', async () => {
  const cfg = await loadAll(paths);
  if (!cfg) throw new Error('config missing');
  cfg.agent.approvals = { deny: ['shell_exec'], ask: ['file_write'], allow: [] };
  await saveAgents(paths.agentsConfig, cfg);
  handlers = buildHandlers(mockModel(), {
    paths,
    modelService: new ModelService(paths.auth, cfg, await loadAuth(paths.auth), seededProviderRegistry())
  });

  await handlers.peer.upsertPeer({ peer: view() });

  const after = await loadAll(paths);
  expect(after?.agent.approvals).toEqual({ deny: ['shell_exec'], ask: ['file_write'], allow: [] });
});

test('getPeer returns one peer without any secret material', async () => {
  await handlers.peer.upsertPeer({ peer: view() });
  const { peer } = await handlers.peer.getPeer({ id: 'peer_HOME00000000' });
  expect(peer).toMatchObject({ id: 'peer_HOME00000000', label: 'home', enabled: false });
  expect(JSON.stringify(peer)).not.toContain('token');
});

test('getPeer throws not_found for an unknown id', async () => {
  await expect(handlers.peer.getPeer({ id: 'peer_UNKNOWN00000' })).rejects.toMatchObject({
    kind: 'not_found'
  });
});

test('setPeerEnabled throws not_found for an unknown id', async () => {
  await expect(handlers.peer.setPeerEnabled({ id: 'peer_UNKNOWN00000', enabled: true })).rejects.toMatchObject({
    kind: 'not_found'
  });
});

test('removePeer throws not_found for an unknown id', async () => {
  await expect(handlers.peer.removePeer({ id: 'peer_UNKNOWN00000' })).rejects.toMatchObject({
    kind: 'not_found'
  });
});

test('setPeerCredential throws not_found for an unknown id', async () => {
  await expect(
    handlers.peer.setPeerCredential({ id: 'peer_UNKNOWN00000', action: 'replace', value: 'x' })
  ).rejects.toMatchObject({ kind: 'not_found' });
});

test('testPeerConnection throws not_found for an unknown id', async () => {
  await expect(handlers.peer.testPeerConnection({ id: 'peer_UNKNOWN00000' })).rejects.toMatchObject({
    kind: 'not_found'
  });
});

test('testPeerConnection reports ok against a reachable peer health endpoint', async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/health') return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      return new Response('not found', { status: 404 });
    }
  });
  try {
    await handlers.peer.upsertPeer({
      peer: view({ baseUrl: `http://127.0.0.1:${server.port}/openai` })
    });
    const result = await handlers.peer.testPeerConnection({ id: 'peer_HOME00000000' });
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  } finally {
    server.stop(true);
  }
});

test('testPeerConnection reports not ok against an unreachable peer', async () => {
  await handlers.peer.upsertPeer({
    peer: view({ baseUrl: 'http://127.0.0.1:1/openai' })
  });
  const result = await handlers.peer.testPeerConnection({ id: 'peer_HOME00000000' });
  expect(result.ok).toBe(false);
  expect(typeof result.error).toBe('string');
});
