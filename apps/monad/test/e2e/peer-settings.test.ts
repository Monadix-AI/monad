// Peer settings CRUD over a real temp ~/.monad: upsert → list (no secret) → set credential (writes
// auth.json + enables) → update (preserves tokenRef) → disable → remove (drops credential). Exercises
// the settings module (modules/settings/peer) the same way the HTTP controller + CLI drive it.

import type { MonadPaths } from '@monad/environment';
import type { PeerView } from '@monad/protocol';

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initMonadHome, loadAll, loadAuth, saveAgents } from '@monad/environment';

import { ModelService } from '#/handlers/settings/model/index.ts';
import { buildHandlers, makeTestPaths, mockModel, seededProviderRegistry } from '../helpers.ts';

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

const view = (over: Partial<PeerView> = {}): PeerView => ({
  id: 'peer_HOME00000000' as PeerView['id'],
  label: 'home',
  baseUrl: 'https://home.example:52749/openai',
  defaultAgent: 'default',
  enabled: false,
  ...over
});

test('upsert → list returns the peer without any secret material', async () => {
  await handlers.peer.upsertPeer({ peer: view() });
  const { peers } = await handlers.peer.listPeers();
  expect(peers).toHaveLength(1);
  expect(peers[0]).toMatchObject({ id: 'peer_HOME00000000', label: 'home', enabled: false });
  // Created with the auth.json-backed tokenRef, never returned over the wire.
  expect(JSON.stringify(peers[0])).not.toContain('secret');
  expect(JSON.stringify(peers[0])).not.toContain('token');
  // config.json carries the ref; auth.json has no credential yet.
  const cfg = await loadAll(paths);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: testing the literal secret-ref syntax
  expect(cfg?.peers[0]?.tokenRef).toBe('${secret:peer/peer_HOME00000000/token}');
});

test('setPeerCredential stores the token in auth.json and enables the peer', async () => {
  await handlers.peer.upsertPeer({ peer: view() });
  await handlers.peer.setPeerCredential({ id: 'peer_HOME00000000', token: 'the-token' });
  const auth = await loadAuth(paths.auth);
  expect(auth?.peerCredentials?.peer_HOME00000000?.token).toBe('the-token');
  const { peers } = await handlers.peer.listPeers();
  expect(peers[0]?.enabled).toBe(true);
});

test('updating a peer preserves its existing tokenRef', async () => {
  await handlers.peer.upsertPeer({ peer: view() });
  await handlers.peer.upsertPeer({ peer: view({ label: 'renamed', baseUrl: 'https://new.example/openai' }) });
  const { peers } = await handlers.peer.listPeers();
  expect(peers).toHaveLength(1);
  expect(peers[0]).toMatchObject({ label: 'renamed', baseUrl: 'https://new.example/openai' });
  const cfg = await loadAll(paths);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: testing the literal secret-ref syntax
  expect(cfg?.peers[0]?.tokenRef).toBe('${secret:peer/peer_HOME00000000/token}');
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

test('remove drops the peer and its credential', async () => {
  await handlers.peer.upsertPeer({ peer: view() });
  await handlers.peer.setPeerCredential({ id: 'peer_HOME00000000', token: 'the-token' });
  await handlers.peer.removePeer({ id: 'peer_HOME00000000' });
  const { peers } = await handlers.peer.listPeers();
  expect(peers).toHaveLength(0);
  const auth = await loadAuth(paths.auth);
  expect(auth?.peerCredentials?.peer_HOME00000000).toBeUndefined();
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
  await expect(handlers.peer.setPeerCredential({ id: 'peer_UNKNOWN00000', token: 'x' })).rejects.toMatchObject({
    kind: 'not_found'
  });
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
