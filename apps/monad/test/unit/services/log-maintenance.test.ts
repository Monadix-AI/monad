import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DAEMON_LOG_KEEP,
  DAEMON_LOG_MAX_BYTES,
  rotateDaemonLog,
  rotateLogFile,
  sweepStaleLogs
} from '#/services/log-maintenance.ts';

let dir: string;
let seq = 0;

beforeEach(() => {
  seq += 1;
  dir = join(tmpdir(), `monad-log-maint-test-${process.pid}-${seq}`);
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('rotateLogFile', () => {
  test('no-op when the log is absent', () => {
    expect(rotateLogFile(join(dir, 'nope.log'), { maxBytes: 10, keep: 3 })).toBe(false);
  });

  test('no-op when under the size cap', () => {
    const p = join(dir, 'a.log');
    writeFileSync(p, 'small');
    expect(rotateLogFile(p, { maxBytes: 1024, keep: 3 })).toBe(false);
    expect(readFileSync(p, 'utf8')).toBe('small');
    expect(existsSync(`${p}.1`)).toBe(false);
  });

  test('rotates when at/over the cap, freeing a fresh path', () => {
    const p = join(dir, 'a.log');
    writeFileSync(p, 'x'.repeat(100));
    expect(rotateLogFile(p, { maxBytes: 100, keep: 3 })).toBe(true);
    expect(existsSync(p)).toBe(false); // caller reopens fresh
    expect(readFileSync(`${p}.1`, 'utf8')).toBe('x'.repeat(100));
  });

  test('cascades generations and drops the oldest beyond keep', () => {
    const p = join(dir, 'a.log');
    writeFileSync(`${p}.1`, 'gen1');
    writeFileSync(`${p}.2`, 'gen2'); // keep=2 → this is the oldest and must be dropped
    writeFileSync(p, 'current');
    expect(rotateLogFile(p, { maxBytes: 1, keep: 2 })).toBe(true);
    expect(readFileSync(`${p}.1`, 'utf8')).toBe('current');
    expect(readFileSync(`${p}.2`, 'utf8')).toBe('gen1');
    expect(existsSync(`${p}.3`)).toBe(false); // never exceeds keep
  });

  test('rotateDaemonLog applies the daemon-log policy constants', () => {
    const p = join(dir, 'daemon.log');
    writeFileSync(p, 'x'.repeat(DAEMON_LOG_MAX_BYTES));
    expect(rotateDaemonLog(p)).toBe(true);
    expect(existsSync(`${p}.1`)).toBe(true);
    expect(DAEMON_LOG_KEEP).toBeGreaterThan(0);
  });
});

describe('sweepStaleLogs', () => {
  const age = (p: string, ms: number, now: number) => {
    const when = (now - ms) / 1000;
    utimesSync(p, when, when);
  };

  test('removes debug logs and developer jsonl older than the cutoff, keeps fresh ones', async () => {
    const now = Date.parse('2026-07-01T00:00:00Z');
    const maxAgeMs = 14 * 24 * 60 * 60 * 1000;

    // Debug logs live in the temp dir (injected here for isolation so we never touch the real one).
    const tempDir = join(dir, 'tmp');
    mkdirSync(tempDir, { recursive: true });
    const oldDebug = join(tempDir, 'monad-debug-2020-01-01.log');
    const freshDebug = join(tempDir, 'monad-debug-2026-07-01.log');
    writeFileSync(oldDebug, 'old');
    writeFileSync(freshDebug, 'new');
    age(oldDebug, maxAgeMs + 60_000, now);
    age(freshDebug, 60_000, now);

    // Developer jsonl live under logsDir.
    const oldSession = join(dir, 'session-abc.jsonl');
    const freshChannel = join(dir, 'channel-xyz.jsonl');
    const unrelated = join(dir, 'daemon.log'); // must never be swept
    writeFileSync(oldSession, '{}');
    writeFileSync(freshChannel, '{}');
    writeFileSync(unrelated, 'keep');
    age(oldSession, maxAgeMs + 60_000, now);
    age(freshChannel, 60_000, now);
    age(unrelated, maxAgeMs + 60_000, now);

    const removed = await sweepStaleLogs({ logsDir: dir, tempDir, maxAgeMs, now });
    expect(removed).toBe(2); // oldDebug + oldSession
    expect(existsSync(oldDebug)).toBe(false);
    expect(existsSync(freshDebug)).toBe(true);
    expect(existsSync(oldSession)).toBe(false);
    expect(existsSync(freshChannel)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });

  test('tolerates a missing logs dir', async () => {
    const removed = await sweepStaleLogs({
      logsDir: join(dir, 'does-not-exist'),
      tempDir: join(dir, 'also-missing'),
      maxAgeMs: 1,
      now: Date.now()
    });
    expect(removed).toBe(0);
  });
});
