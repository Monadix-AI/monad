import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LogMaintenanceService } from '#/services/log-maintenance.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

let root: string;
let logsDir: string;
let captureDir: string;
let debugDir: string;
let debugPath: string;
let seq = 0;

beforeEach(() => {
  seq += 1;
  root = join(tmpdir(), `monad-log-truncate-unix-${process.pid}-${seq}`);
  logsDir = join(root, 'logs');
  captureDir = join(logsDir, 'mesh-agent-fixture-capture');
  debugDir = join(root, 'tmp');
  debugPath = join(debugDir, 'monad-debug-2026-07-21.log');
  mkdirSync(captureDir, { recursive: true });
  mkdirSync(debugDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, contents: string, ageMs: number, now: number): number {
  writeFileSync(path, contents);
  const when = (now - ageMs) / 1000;
  utimesSync(path, when, when);
  return Buffer.byteLength(contents);
}

function service(now: number, fileSystem: ConstructorParameters<typeof LogMaintenanceService>[0]['fileSystem'] = {}) {
  return new LogMaintenanceService({ captureDir, debugDir, debugPath, logsDir, now: () => now, fileSystem });
}

test('clear-all truncates fixed and recent debug append targets on Unix', async () => {
  const now = Date.parse('2026-07-21T12:00:00Z');
  const daemonLog = join(logsDir, 'daemon.log');
  const startupLog = join(logsDir, 'startup.log');
  const recentDebug = join(debugDir, 'monad-debug-2026-07-20.log');
  const bytes =
    write(daemonLog, 'daemon', 2 * DAY_MS, now) +
    write(startupLog, 'startup', 2 * DAY_MS, now) +
    write(debugPath, 'active-debug', 30 * DAY_MS, now) +
    write(recentDebug, 'recent-debug', 60_000, now);

  expect(await service(now).clearAll()).toEqual({ filesCleared: 4, filesFailed: 0, bytesFreed: bytes });
  expect([daemonLog, startupLog, debugPath, recentDebug].map((path) => readFileSync(path, 'utf8'))).toEqual([
    '',
    '',
    '',
    ''
  ]);
});

test('retention truncates stale fixed and active debug append targets on Unix', async () => {
  const now = Date.parse('2026-07-21T12:00:00Z');
  const daemonLog = join(logsDir, 'daemon.log');
  const startupLog = join(logsDir, 'startup.log');
  const bytes =
    write(daemonLog, 'daemon', 8 * DAY_MS, now) +
    write(startupLog, 'startup', 8 * DAY_MS, now) +
    write(debugPath, 'active-debug', 8 * DAY_MS, now);

  expect(await service(now).sweep({ enabled: true, retentionDays: 7 })).toEqual({
    filesCleared: 3,
    filesFailed: 0,
    bytesFreed: bytes
  });
  expect([daemonLog, startupLog, debugPath].map((path) => readFileSync(path, 'utf8'))).toEqual(['', '', '']);
});

test('clear-all truncates a stale debug file refreshed on the same inode before mutation on Unix', async () => {
  const now = Date.parse('2026-07-21T12:00:00Z');
  const debugLog = join(debugDir, 'monad-debug-2026-06-01.log');
  const bytes = write(debugLog, 'still-active', 30 * DAY_MS, now);
  const inventoried = await lstat(debugLog);
  let entryLstatCalls = 0;
  const maintenance = service(now, {
    async lstat(path) {
      if (path === debugLog && ++entryLstatCalls === 2) utimesSync(debugLog, now / 1000, now / 1000);
      return lstat(path);
    }
  });

  expect(await maintenance.clearAll()).toEqual({ filesCleared: 1, filesFailed: 0, bytesFreed: bytes });
  const current = await lstat(debugLog);
  expect({ contents: readFileSync(debugLog, 'utf8'), sameInode: current.ino === inventoried.ino }).toEqual({
    contents: '',
    sameInode: true
  });
});
