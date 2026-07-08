// QdrantManager orchestration over injected seams (no real download/process/network): ensure =
// download-if-missing → spawn → health-poll → url; idempotent; binary cached; stop kills.

import type { QdrantProcess } from '#/services/memory/qdrant.ts';

import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { QdrantManager } from '#/services/memory/qdrant.ts';

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;
const rawAsset = async () => ({ name: 'qdrant', bytes: new TextEncoder().encode('#!/bin/sh\n') }); // raw (no archive ext)
const fakeProc = (): { proc: QdrantProcess; killed: () => number; crash: () => void } => {
  let n = 0;
  let resolveExit: () => void = () => {};
  const exited = new Promise<void>((r) => {
    resolveExit = r;
  });
  return {
    proc: {
      kill: () => {
        n++;
        resolveExit();
      },
      exited
    },
    killed: () => n,
    crash: () => resolveExit() // simulate an unexpected exit (no kill)
  };
};

// A process that's already dead the moment it's spawned — models a binary that won't stay up.
const deadProc = (): QdrantProcess => ({ kill: () => {}, exited: Promise.resolve() });

test('ensureUrl downloads, spawns with loopback env, waits for health, returns the REST url', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qd-'));
  let spawns = 0;
  let capturedEnv: Record<string, string> = {};
  let capturedCwd = '';
  const m = new QdrantManager({
    binDir: join(root, 'bin'),
    dataDir: join(root, 'data'),
    port: 16333,
    fetch: rawAsset,
    spawn: (_bin, _args, env, cwd) => {
      spawns++;
      capturedEnv = env;
      capturedCwd = cwd;
      return fakeProc().proc;
    },
    probe: async () => true,
    log: silent
  });
  expect(await m.ensureUrl()).toBe('http://127.0.0.1:16333');
  expect(spawns).toBe(1);
  const binName = process.platform === 'win32' ? 'qdrant.exe' : 'qdrant';
  expect(existsSync(join(root, 'bin', binName))).toBe(true); // downloaded + cached
  expect(capturedEnv.QDRANT__SERVICE__HOST).toBe('127.0.0.1'); // loopback only
  expect(capturedEnv.QDRANT__SERVICE__HTTP_PORT).toBe('16333');
  expect(capturedEnv.QDRANT__SERVICE__GRPC_PORT).toBe('16334');
  expect(capturedEnv.QDRANT__STORAGE__STORAGE_PATH).toBe(join(root, 'data'));
  expect(capturedEnv.QDRANT__STORAGE__SNAPSHOTS_PATH).toBe(join(root, 'data', 'snapshots'));
  expect(capturedCwd).toBe(join(root, 'data')); // qdrant's cwd-relative writes stay in dataDir, not the daemon cwd
  // idempotent: a second call neither re-fetches nor re-spawns
  await m.ensureUrl();
  expect(spawns).toBe(1);
});

test('a cached binary is reused (no re-download)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qd-'));
  const make = (onFetch: () => void) =>
    new QdrantManager({
      binDir: join(root, 'bin'),
      dataDir: join(root, 'data'),
      port: 17000,
      fetch: async () => {
        onFetch();
        return rawAsset();
      },
      spawn: () => fakeProc().proc,
      probe: async () => true,
      log: silent
    });
  let fetches = 0;
  await make(() => fetches++).ensureUrl();
  expect(fetches).toBe(1);
  await make(() => fetches++).ensureUrl(); // binary already on disk
  expect(fetches).toBe(1);
});

test('ensureUrl rejects when qdrant never becomes healthy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qd-'));
  const m = new QdrantManager({
    binDir: join(root, 'bin'),
    dataDir: join(root, 'data'),
    port: 18000,
    fetch: rawAsset,
    spawn: () => fakeProc().proc,
    probe: async () => false,
    startTimeoutMs: 50,
    log: silent
  });
  await expect(m.ensureUrl()).rejects.toThrow(/healthy/);
});

test('stop kills the process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qd-'));
  const h = fakeProc();
  const m = new QdrantManager({
    binDir: join(root, 'bin'),
    dataDir: join(root, 'data'),
    port: 19000,
    fetch: rawAsset,
    spawn: () => h.proc,
    probe: async () => true,
    log: silent
  });
  await m.ensureUrl();
  await m.stop();
  expect(h.killed()).toBe(1);
});

test('an unexpected exit triggers a supervised restart on the same port', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qd-'));
  const p1 = fakeProc();
  let spawns = 0;
  const m = new QdrantManager({
    binDir: join(root, 'bin'),
    dataDir: join(root, 'data'),
    port: 20000,
    fetch: rawAsset,
    spawn: () => {
      spawns++;
      return spawns === 1 ? p1.proc : fakeProc().proc;
    },
    probe: async () => true,
    restartBaseMs: 1,
    log: silent
  });
  expect(await m.ensureUrl()).toBe('http://127.0.0.1:20000');
  expect(spawns).toBe(1);
  p1.crash(); // qdrant dies mid-session
  await Bun.sleep(40); // let the supervisor back off + relaunch
  expect(spawns).toBe(2); // restarted automatically — mem0's cached client keeps using the same URL
  await m.stop();
});

test('a process that can never stay up stops after maxRestarts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qd-'));
  const p1 = fakeProc();
  let serverUp = true;
  let spawns = 0;
  const m = new QdrantManager({
    binDir: join(root, 'bin'),
    dataDir: join(root, 'data'),
    port: 21000,
    fetch: rawAsset,
    spawn: () => {
      spawns++;
      return spawns === 1 ? p1.proc : deadProc(); // every restart immediately dies
    },
    probe: async () => serverUp,
    maxRestarts: 2,
    restartBaseMs: 1,
    log: silent
  });
  await m.ensureUrl(); // spawn #1 is healthy
  serverUp = false;
  p1.crash();
  await Bun.sleep(900); // 2 restart attempts (each polls then sees the exit) then gives up
  expect(spawns).toBe(3); // initial + maxRestarts, then it stops trying
  await m.stop();
});

test('a binary that dies on first boot is discarded so the next attempt re-downloads', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qd-'));
  const m = new QdrantManager({
    binDir: join(root, 'bin'),
    dataDir: join(root, 'data'),
    port: 22000,
    fetch: rawAsset,
    spawn: () => deadProc(), // exits during startup
    probe: async () => false,
    startTimeoutMs: 2000,
    log: silent
  });
  await expect(m.ensureUrl()).rejects.toThrow(/exited during startup/);
  expect(existsSync(join(root, 'bin', 'qdrant'))).toBe(false); // bad binary removed
});
