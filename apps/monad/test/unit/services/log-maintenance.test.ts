import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { readdir, lstat as realLstat, unlink as realUnlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DAEMON_LOG_KEEP,
  DAEMON_LOG_MAX_BYTES,
  LogMaintenanceService,
  rotateDaemonLog,
  rotateLogFile,
  sweepStaleLogs
} from '#/services/log-maintenance.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

let root: string;
let logsDir: string;
let captureDir: string;
let debugDir: string;
let debugPath: string;
let seq = 0;

beforeEach(() => {
  seq += 1;
  root = join(tmpdir(), `monad-log-maint-test-${process.pid}-${seq}`);
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

function service(now: number): LogMaintenanceService {
  return new LogMaintenanceService({ captureDir, debugDir, debugPath, logsDir, now: () => now });
}

describe('rotateLogFile', () => {
  test('no-op when the log is absent', () => {
    expect(rotateLogFile(join(root, 'nope.log'), { maxBytes: 10, keep: 3 })).toBe(false);
  });

  test('no-op when under the size cap', () => {
    const path = join(root, 'a.log');
    writeFileSync(path, 'small');
    expect(rotateLogFile(path, { maxBytes: 1024, keep: 3 })).toBe(false);
    expect({ contents: readFileSync(path, 'utf8'), rotations: existsSync(`${path}.1`) }).toEqual({
      contents: 'small',
      rotations: false
    });
  });

  test('rotates when at the cap and cascades bounded generations', () => {
    const path = join(root, 'a.log');
    writeFileSync(`${path}.1`, 'gen1');
    writeFileSync(`${path}.2`, 'gen2');
    writeFileSync(path, 'current');

    expect(rotateLogFile(path, { maxBytes: 1, keep: 2 })).toBe(true);
    expect({
      currentExists: existsSync(path),
      first: readFileSync(`${path}.1`, 'utf8'),
      second: readFileSync(`${path}.2`, 'utf8'),
      thirdExists: existsSync(`${path}.3`)
    }).toEqual({ currentExists: false, first: 'current', second: 'gen1', thirdExists: false });
  });

  test('rotateDaemonLog applies the daemon-log policy constants', () => {
    const path = join(root, 'daemon.log');
    writeFileSync(path, 'x'.repeat(DAEMON_LOG_MAX_BYTES));
    expect({ kept: DAEMON_LOG_KEEP, rotated: rotateDaemonLog(path), firstExists: existsSync(`${path}.1`) }).toEqual({
      kept: 5,
      rotated: true,
      firstExists: true
    });
  });
});

describe('LogMaintenanceService', () => {
  test('clear-all unlinks closed artifacts and preserves unknown paths', async () => {
    const now = Date.parse('2026-07-21T12:00:00Z');
    const rotation = join(logsDir, 'daemon.log.1');
    const lastRotation = join(logsDir, `daemon.log.${DAEMON_LOG_KEEP}`);
    const unknownRotation = join(logsDir, `daemon.log.${DAEMON_LOG_KEEP + 1}`);
    const staleSession = join(logsDir, 'session-abc.jsonl');
    const staleDebug = join(debugDir, 'monad-debug-2026-06-01.log');
    const capture = join(captureDir, 'codex-mesh_100000000001-oep_100000000001.jsonl');
    const captureTemp = join(
      captureDir,
      '.codex-mesh_100000000002-oep_100000000002.jsonl.123e4567-e89b-42d3-a456-426614174000.tmp'
    );
    const unknownSentinel = join(logsDir, 'keep-me.log');
    const captureSentinel = join(captureDir, 'human-notes.jsonl');
    const symlinkTarget = join(root, 'outside.jsonl');
    const matchedSymlink = join(logsDir, 'session-symlink.jsonl');
    let unlinkBytes = 0;

    unlinkBytes += write(staleDebug, 'stale-debug', 30 * DAY_MS, now);
    unlinkBytes += write(staleSession, 'session', 60_000, now);
    unlinkBytes += write(rotation, 'rotation', 30 * DAY_MS, now);
    unlinkBytes += write(lastRotation, 'last-rotation', 30 * DAY_MS, now);
    write(unknownRotation, 'unknown-rotation', 30 * DAY_MS, now);
    unlinkBytes += write(capture, 'capture', 60_000, now);
    unlinkBytes += write(captureTemp, 'capture-temp', 60_000, now);
    write(unknownSentinel, 'keep', 30 * DAY_MS, now);
    write(captureSentinel, 'keep-capture', 30 * DAY_MS, now);
    writeFileSync(symlinkTarget, 'outside');
    symlinkSync(symlinkTarget, matchedSymlink);

    expect(await service(now).clearAll()).toEqual({ filesCleared: 6, filesFailed: 1, bytesFreed: unlinkBytes });
    expect({
      removed: [staleDebug, staleSession, rotation, lastRotation, capture, captureTemp].map(existsSync),
      unknown: readFileSync(unknownSentinel, 'utf8'),
      unknownRotation: readFileSync(unknownRotation, 'utf8'),
      captureUnknown: readFileSync(captureSentinel, 'utf8'),
      captureDirectory: existsSync(captureDir),
      symlink: readFileSync(matchedSymlink, 'utf8')
    }).toEqual({
      // presence-ok: clear operation removed every matched closed artifact
      removed: [false, false, false, false, false, false],
      unknown: 'keep',
      unknownRotation: 'unknown-rotation',
      captureUnknown: 'keep-capture',
      // presence-ok: clear operation preserved the capture root directory
      captureDirectory: true,
      symlink: 'outside'
    });
  });

  test('age sweep deletes stale closed logs and excludes rotations', async () => {
    const now = Date.parse('2026-07-21T12:00:00Z');
    const staleAge = 8 * DAY_MS;
    const recentAge = 60_000;
    const staleForeignDebug = join(debugDir, 'monad-debug-2026-07-01.log');
    const recentForeignDebug = join(debugDir, 'monad-debug-2026-07-20.log');
    const staleSession = join(logsDir, 'session-stale.jsonl');
    const recentChannel = join(logsDir, 'channel-recent.jsonl');
    const rotation = join(logsDir, 'daemon.log.1');
    const staleCapture = join(captureDir, 'codex-mesh_100000000003-oep_100000000003.jsonl');
    const staleCaptureTemp = join(
      captureDir,
      '.codex-mesh_100000000004-oep_100000000004.jsonl.123e4567-e89b-42d3-a456-426614174000.tmp'
    );
    const recentCapture = join(captureDir, 'codex-mesh_100000000005-oep_100000000005.jsonl');
    let unlinkBytes = 0;

    unlinkBytes += write(staleForeignDebug, 'stale-debug', staleAge, now);
    write(recentForeignDebug, 'recent-debug', recentAge, now);
    unlinkBytes += write(staleSession, 'stale-session', staleAge, now);
    write(recentChannel, 'recent-channel', recentAge, now);
    write(rotation, 'old-rotation', staleAge, now);
    unlinkBytes += write(staleCapture, 'stale-capture', staleAge, now);
    unlinkBytes += write(staleCaptureTemp, 'stale-capture-temp', staleAge, now);
    write(recentCapture, 'recent-capture', recentAge, now);

    expect(await service(now).sweep({ enabled: true, retentionDays: 7 })).toEqual({
      filesCleared: 4,
      filesFailed: 0,
      bytesFreed: unlinkBytes
    });
    expect({
      staleRemoved: [staleForeignDebug, staleSession, staleCapture, staleCaptureTemp].map(existsSync),
      recent: [recentForeignDebug, recentChannel, recentCapture].map((path) => readFileSync(path, 'utf8')),
      rotation: readFileSync(rotation, 'utf8')
    }).toEqual({
      // presence-ok: retention operation removed every stale matched closed artifact
      staleRemoved: [false, false, false, false],
      recent: ['recent-debug', 'recent-channel', 'recent-capture'],
      rotation: 'old-rotation'
    });
  });

  test('retention preserves a stale developer log refreshed on the same inode before mutation', async () => {
    const now = Date.parse('2026-07-21T12:00:00Z');
    const sessionLog = join(logsDir, 'session-refreshed.jsonl');
    write(sessionLog, 'still-active', 8 * DAY_MS, now);
    const inventoried = await realLstat(sessionLog);
    let entryLstatCalls = 0;
    const maintenance = new LogMaintenanceService({
      captureDir,
      debugDir,
      debugPath,
      logsDir,
      now: () => now,
      fileSystem: {
        async lstat(path) {
          if (path === sessionLog && ++entryLstatCalls === 2) {
            utimesSync(sessionLog, now / 1000, now / 1000);
          }
          return realLstat(path);
        }
      }
    });

    expect(await maintenance.sweep({ enabled: true, retentionDays: 7 })).toEqual({
      filesCleared: 0,
      filesFailed: 0,
      bytesFreed: 0
    });
    const current = await realLstat(sessionLog);
    expect({ contents: readFileSync(sessionLog, 'utf8'), sameInode: current.ino === inventoried.ino }).toEqual({
      contents: 'still-active',
      sameInode: true
    });
  });

  test('preview reports pre-operation bytes without mutating the inventory', async () => {
    const now = Date.parse('2026-07-21T12:00:00Z');
    const daemonLog = join(logsDir, 'daemon.log');
    const staleSession = join(logsDir, 'session-stale.jsonl');
    const rotation = join(logsDir, 'daemon.log.1');
    const daemon = write(daemonLog, 'daemon-preview', 8 * DAY_MS, now);
    const session = write(staleSession, 'session-preview', 8 * DAY_MS, now);
    write(rotation, 'rotation-preview', 8 * DAY_MS, now);

    expect(await service(now).preview({ enabled: true, retentionDays: 7 })).toEqual({
      files: 2,
      bytes: daemon + session
    });
    expect({
      daemon: readFileSync(daemonLog, 'utf8'),
      session: readFileSync(staleSession, 'utf8'),
      files: (await readdir(logsDir)).sort()
    }).toEqual({
      daemon: 'daemon-preview',
      session: 'session-preview',
      files: ['daemon.log', 'daemon.log.1', 'mesh-agent-fixture-capture', 'session-stale.jsonl']
    });
  });

  test('production capture names are previewed and cleared while nearby lookalikes are preserved', async () => {
    const now = Date.parse('2026-07-21T12:00:00Z');
    const finalCapture = join(captureDir, 'codex-mesh_100000000010-oep_100000000010.jsonl');
    const tempCapture = join(
      captureDir,
      '.codex-mesh_100000000011-oep_100000000011.jsonl.123e4567-e89b-42d3-a456-426614174000.tmp'
    );
    const legacyPrefix = join(captureDir, 'codex-mes_100000000010-oep_100000000010.jsonl');
    const wrongEpoch = join(captureDir, 'codex-mesh_100000000010-ope_100000000010.jsonl');
    const shortBody = join(captureDir, 'codex-mesh_short-oep_100000000010.jsonl');
    const nonV4Temp = join(
      captureDir,
      '.codex-mesh_100000000010-oep_100000000010.jsonl.123e4567-e89b-12d3-a456-426614174000.tmp'
    );
    const uppercaseMesh = join(captureDir, 'codex-MESH_100000000020-oep_100000000020.jsonl');
    const uppercaseEpoch = join(captureDir, 'codex-mesh_100000000021-OEP_100000000021.jsonl');
    const uppercaseJsonl = join(captureDir, 'codex-mesh_100000000022-oep_100000000022.JSONL');
    const uppercaseTemp = join(
      captureDir,
      '.codex-mesh_100000000023-oep_100000000023.jsonl.123e4567-e89b-42d3-a456-426614174000.TMP'
    );
    const uppercaseUuid = join(
      captureDir,
      '.codex-mesh_100000000024-oep_100000000024.jsonl.123E4567-e89b-42d3-a456-426614174000.tmp'
    );
    const finalBytes = write(finalCapture, 'final-capture', 8 * DAY_MS, now);
    const tempBytes = write(tempCapture, 'temp-capture', 8 * DAY_MS, now);
    write(legacyPrefix, 'legacy-prefix', 8 * DAY_MS, now);
    write(wrongEpoch, 'wrong-epoch', 8 * DAY_MS, now);
    write(shortBody, 'short-body', 8 * DAY_MS, now);
    write(nonV4Temp, 'non-v4-temp', 8 * DAY_MS, now);
    write(uppercaseMesh, 'uppercase-mesh', 8 * DAY_MS, now);
    write(uppercaseEpoch, 'uppercase-epoch', 8 * DAY_MS, now);
    write(uppercaseJsonl, 'uppercase-jsonl', 8 * DAY_MS, now);
    write(uppercaseTemp, 'uppercase-temp', 8 * DAY_MS, now);
    write(uppercaseUuid, 'uppercase-uuid', 8 * DAY_MS, now);
    const maintenance = service(now);

    expect(await maintenance.preview({ enabled: true, retentionDays: 7 })).toEqual({
      files: 2,
      bytes: finalBytes + tempBytes
    });
    expect(await maintenance.clearAll()).toEqual({
      filesCleared: 2,
      filesFailed: 0,
      bytesFreed: finalBytes + tempBytes
    });
    expect({
      cleared: [finalCapture, tempCapture].map(existsSync),
      preserved: [
        legacyPrefix,
        wrongEpoch,
        shortBody,
        nonV4Temp,
        uppercaseMesh,
        uppercaseEpoch,
        uppercaseJsonl,
        uppercaseTemp,
        uppercaseUuid
      ].map((path) => readFileSync(path, 'utf8'))
    }).toEqual({
      // presence-ok: clear operation removed only production-shaped capture files
      cleared: [false, false],
      preserved: [
        'legacy-prefix',
        'wrong-epoch',
        'short-body',
        'non-v4-temp',
        'uppercase-mesh',
        'uppercase-epoch',
        'uppercase-jsonl',
        'uppercase-temp',
        'uppercase-uuid'
      ]
    });
  });

  test('disabled age cleanup is an exact no-op', async () => {
    const now = Date.parse('2026-07-21T12:00:00Z');
    const staleSession = join(logsDir, 'session-stale.jsonl');
    write(staleSession, 'keep', 30 * DAY_MS, now);

    expect(await service(now).sweep({ enabled: false, retentionDays: 1 })).toEqual({
      filesCleared: 0,
      filesFailed: 0,
      bytesFreed: 0
    });
    expect(readFileSync(staleSession, 'utf8')).toBe('keep');
  });

  test('a symlinked capture root is never traversed', async () => {
    const now = Date.parse('2026-07-21T12:00:00Z');
    const outside = join(root, 'outside-captures');
    const symlinkedCaptureDir = join(logsDir, 'capture-link');
    const outsideCapture = join(outside, 'codex-mesh_100000000020-oep_100000000020.jsonl');
    mkdirSync(outside, { recursive: true });
    write(outsideCapture, 'outside', 30 * DAY_MS, now);
    symlinkSync(outside, symlinkedCaptureDir);
    const linkedService = new LogMaintenanceService({
      captureDir: symlinkedCaptureDir,
      debugDir,
      debugPath,
      logsDir,
      now: () => now
    });

    expect(await linkedService.clearAll()).toEqual({ filesCleared: 0, filesFailed: 0, bytesFreed: 0 });
    expect(readFileSync(outsideCapture, 'utf8')).toBe('outside');
  });

  test('missing inventory roots are an empty preview and mutation no-op', async () => {
    const now = Date.parse('2026-07-21T12:00:00Z');
    const maintenance = new LogMaintenanceService({
      captureDir: join(root, 'missing-captures'),
      debugDir: join(root, 'missing-debug'),
      debugPath: join(root, 'missing-debug', 'active.log'),
      logsDir: join(root, 'missing-logs'),
      now: () => now
    });

    expect(await maintenance.preview({ enabled: true, retentionDays: 7 })).toEqual({ files: 0, bytes: 0 });
    expect(await maintenance.clearAll()).toEqual({ filesCleared: 0, filesFailed: 0, bytesFreed: 0 });
  });

  test('non-missing root traversal errors fail preview and count once in mutations', async () => {
    const now = Date.parse('2026-07-21T12:00:00Z');
    for (const failedOperation of ['lstat', 'readdir'] as const) {
      const maintenance = new LogMaintenanceService({
        captureDir,
        debugDir,
        debugPath,
        logsDir,
        now: () => now,
        fileSystem: {
          async lstat(path) {
            if (failedOperation === 'lstat' && path === logsDir) {
              throw Object.assign(new Error('injected root lstat failure'), { code: 'EACCES' });
            }
            return realLstat(path);
          },
          async readdir(path) {
            if (failedOperation === 'readdir' && path === logsDir) {
              throw Object.assign(new Error('injected root readdir failure'), { code: 'EACCES' });
            }
            return readdir(path);
          }
        }
      });

      await expect(maintenance.preview({ enabled: true, retentionDays: 7 })).rejects.toThrow('Log inventory failed');
      expect(await maintenance.clearAll()).toEqual({ filesCleared: 0, filesFailed: 1, bytesFreed: 0 });
    }
  });

  test('entry stat errors fail preview without caching zero and count once in mutations', async () => {
    let now = Date.parse('2026-07-21T12:00:00Z');
    const daemonLog = join(logsDir, 'daemon.log');
    const daemonBytes = write(daemonLog, 'daemon', 8 * DAY_MS, now);
    let failEntryStat = true;
    const maintenance = new LogMaintenanceService({
      captureDir,
      debugDir,
      debugPath,
      logsDir,
      now: () => now,
      fileSystem: {
        async lstat(path) {
          if (failEntryStat && path === daemonLog) {
            throw Object.assign(new Error('injected entry lstat failure'), { code: 'EACCES' });
          }
          return realLstat(path);
        }
      }
    });

    await expect(maintenance.preview({ enabled: true, retentionDays: 7 })).rejects.toThrow('Log inventory failed');
    expect(await maintenance.clearAll()).toEqual({ filesCleared: 0, filesFailed: 1, bytesFreed: 0 });

    failEntryStat = false;
    now += 2_001;
    expect(await maintenance.preview({ enabled: true, retentionDays: 7 })).toEqual({ files: 1, bytes: daemonBytes });
  });

  test('operation-time entry replacement is rejected before truncation', async () => {
    const now = Date.parse('2026-07-21T12:00:00Z');
    const daemonLog = join(logsDir, 'daemon.log');
    const outside = join(root, 'outside-truncate.log');
    write(daemonLog, 'daemon', 60_000, now);
    writeFileSync(outside, 'outside');
    let daemonLstatCalls = 0;
    const maintenance = new LogMaintenanceService({
      captureDir,
      debugDir,
      debugPath,
      logsDir,
      now: () => now,
      fileSystem: {
        async lstat(path) {
          if (path === daemonLog && ++daemonLstatCalls === 2) {
            rmSync(daemonLog);
            symlinkSync(outside, daemonLog);
          }
          return realLstat(path);
        }
      }
    });

    expect(await maintenance.clearAll()).toEqual({ filesCleared: 0, filesFailed: 1, bytesFreed: 0 });
    expect({
      outside: readFileSync(outside, 'utf8'),
      replacementIsSymlink: (await realLstat(daemonLog)).isSymbolicLink()
    }).toEqual({
      outside: 'outside',
      replacementIsSymlink: true
    });
  });

  test('operation-time root replacement is rejected before unlink', async () => {
    const now = Date.parse('2026-07-21T12:00:00Z');
    const name = 'codex-mesh_100000000030-oep_100000000030.jsonl';
    const capture = join(captureDir, name);
    const displaced = join(logsDir, 'displaced-captures');
    const outside = join(root, 'outside-captures-race');
    const outsideCapture = join(outside, name);
    write(capture, 'inside', 8 * DAY_MS, now);
    mkdirSync(outside, { recursive: true });
    writeFileSync(outsideCapture, 'outside');
    let captureRootLstatCalls = 0;
    const maintenance = new LogMaintenanceService({
      captureDir,
      debugDir,
      debugPath,
      logsDir,
      now: () => now,
      fileSystem: {
        async lstat(path) {
          if (path === captureDir && ++captureRootLstatCalls === 2) {
            renameSync(captureDir, displaced);
            symlinkSync(outside, captureDir);
          }
          return realLstat(path);
        }
      }
    });

    expect(await maintenance.clearAll()).toEqual({ filesCleared: 0, filesFailed: 1, bytesFreed: 0 });
    expect({
      outside: readFileSync(outsideCapture, 'utf8'),
      displaced: readFileSync(join(displaced, name), 'utf8')
    }).toEqual({
      outside: 'outside',
      displaced: 'inside'
    });
  });

  test('truncate fails closed when O_NOFOLLOW cannot safely open the target', async () => {
    const now = Date.parse('2026-07-21T12:00:00Z');
    const daemonLog = join(logsDir, 'daemon.log');
    const outside = join(root, 'outside-no-follow.log');
    write(daemonLog, 'daemon', 60_000, now);
    writeFileSync(outside, 'outside');
    let openedFlags = 0;
    const maintenance = new LogMaintenanceService({
      captureDir,
      debugDir,
      debugPath,
      logsDir,
      noFollowFlag: constants.O_NOFOLLOW || 0x100,
      now: () => now,
      fileSystem: {
        async open(path, flags) {
          openedFlags = flags;
          rmSync(path);
          symlinkSync(outside, path);
          throw Object.assign(new Error('refused symlink'), { code: 'ELOOP' });
        }
      }
    });

    expect(await maintenance.clearAll()).toEqual({ filesCleared: 0, filesFailed: 1, bytesFreed: 0 });
    expect({
      noFollow: (openedFlags & (constants.O_NOFOLLOW || 0x100)) !== 0,
      outside: readFileSync(outside, 'utf8')
    }).toEqual({
      noFollow: true,
      outside: 'outside'
    });
  });

  test('pathname unlink is immediately preceded by bounded root, parent, and entry revalidation', async () => {
    const now = Date.parse('2026-07-21T12:00:00Z');
    const capture = join(captureDir, 'codex-mesh_100000000040-oep_100000000040.jsonl');
    write(capture, 'capture', 8 * DAY_MS, now);
    const events: string[] = [];
    const maintenance = new LogMaintenanceService({
      captureDir,
      debugDir,
      debugPath,
      logsDir,
      now: () => now,
      fileSystem: {
        async lstat(path) {
          events.push(`lstat:${path}`);
          return realLstat(path);
        },
        async unlink(path) {
          events.push(`unlink:${path}`);
          return realUnlink(path);
        }
      }
    });

    expect(await maintenance.clearAll()).toEqual({ filesCleared: 1, filesFailed: 0, bytesFreed: 7 });
    expect(events.slice(-4)).toEqual([
      `lstat:${captureDir}`,
      `lstat:${captureDir}`,
      `lstat:${capture}`,
      `unlink:${capture}`
    ]);
  });

  test('truncate fails closed when the platform has no O_NOFOLLOW flag', async () => {
    const now = Date.parse('2026-07-21T12:00:00Z');
    const daemonLog = join(logsDir, 'daemon.log');
    write(daemonLog, 'daemon', 60_000, now);
    let openCalls = 0;
    const maintenance = new LogMaintenanceService({
      captureDir,
      debugDir,
      debugPath,
      logsDir,
      noFollowFlag: 0,
      now: () => now,
      fileSystem: {
        async open() {
          openCalls += 1;
          throw new Error('must not open without O_NOFOLLOW');
        }
      }
    });

    expect(await maintenance.clearAll()).toEqual({ filesCleared: 0, filesFailed: 1, bytesFreed: 0 });
    expect({ contents: readFileSync(daemonLog, 'utf8'), openCalls }).toEqual({ contents: 'daemon', openCalls: 0 });
  });

  test('stop rejects every new operation including a disabled sweep', async () => {
    const stopped = service(Date.parse('2026-07-21T12:00:00Z'));
    stopped.stop();

    await expect(stopped.clearAll()).rejects.toThrow('Log maintenance service has stopped');
    await expect(stopped.sweep({ enabled: false, retentionDays: 14 })).rejects.toThrow(
      'Log maintenance service has stopped'
    );
    await expect(stopped.preview({ enabled: true, retentionDays: 14 })).rejects.toThrow(
      'Log maintenance service has stopped'
    );
  });
});

describe('sweepStaleLogs compatibility', () => {
  test('removes only stale logger-owned debug and developer files', async () => {
    const now = Date.parse('2026-07-21T12:00:00Z');
    const oldDebug = join(debugDir, 'monad-debug-2026-06-01.log');
    const freshDebug = join(debugDir, 'monad-debug-2026-07-21.log');
    const oldSession = join(logsDir, 'session-old.jsonl');
    const freshChannel = join(logsDir, 'channel-fresh.jsonl');
    const unrelated = join(logsDir, 'daemon.log');
    write(oldDebug, 'old-debug', 8 * DAY_MS, now);
    write(freshDebug, 'fresh-debug', 60_000, now);
    write(oldSession, 'old-session', 8 * DAY_MS, now);
    write(freshChannel, 'fresh-channel', 60_000, now);
    write(unrelated, 'daemon', 8 * DAY_MS, now);

    expect(await sweepStaleLogs({ logsDir, tempDir: debugDir, maxAgeMs: 7 * DAY_MS, now })).toBe(2);
    expect({
      removed: [oldDebug, oldSession].map(existsSync),
      kept: [freshDebug, freshChannel, unrelated].map((path) => readFileSync(path, 'utf8'))
    }).toEqual({
      // presence-ok: compatibility sweep removed stale logger-owned files
      removed: [false, false],
      kept: ['fresh-debug', 'fresh-channel', 'daemon']
    });
  });

  test('tolerates missing roots', async () => {
    expect(
      await sweepStaleLogs({
        logsDir: join(root, 'missing-logs'),
        tempDir: join(root, 'missing-temp'),
        maxAgeMs: 1,
        now: Date.now()
      })
    ).toBe(0);
  });

  test('preserves a stale developer log refreshed on the same inode before compatibility unlink', async () => {
    const now = Date.parse('2026-07-21T12:00:00Z');
    const sessionLog = join(logsDir, 'session-refreshed.jsonl');
    write(sessionLog, 'still-active', 8 * DAY_MS, now);
    const inventoried = await realLstat(sessionLog);
    let entryLstatCalls = 0;

    expect(
      await sweepStaleLogs({
        logsDir,
        tempDir: join(root, 'missing-debug'),
        maxAgeMs: 7 * DAY_MS,
        now,
        fileSystem: {
          async lstat(path) {
            if (path === sessionLog && ++entryLstatCalls === 2) {
              utimesSync(sessionLog, now / 1000, now / 1000);
            }
            return realLstat(path);
          }
        }
      })
    ).toBe(0);
    const current = await realLstat(sessionLog);
    expect({ contents: readFileSync(sessionLog, 'utf8'), sameInode: current.ino === inventoried.ino }).toEqual({
      contents: 'still-active',
      sameInode: true
    });
  });

  test('does not traverse a symlinked compatibility root', async () => {
    const now = Date.parse('2026-07-21T12:00:00Z');
    const outside = join(root, 'outside-developer-logs');
    const linkedLogs = join(root, 'linked-logs');
    const outsideSession = join(outside, 'session-outside.jsonl');
    mkdirSync(outside, { recursive: true });
    write(outsideSession, 'outside', 30 * DAY_MS, now);
    symlinkSync(outside, linkedLogs);

    expect(await sweepStaleLogs({ logsDir: linkedLogs, tempDir: join(root, 'missing'), maxAgeMs: DAY_MS, now })).toBe(
      0
    );
    expect(readFileSync(outsideSession, 'utf8')).toBe('outside');
  });
});
