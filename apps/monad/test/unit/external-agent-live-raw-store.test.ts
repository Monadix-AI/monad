import { expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanupStaleLiveRawStores, LiveRawStore } from '#/services/external-agent/live-raw-store.ts';

async function withTempDirectory(run: (directory: string) => Promise<void> | void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'monad-live-raw-store-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('live raw store preserves committed frames byte-for-byte in one global order', async () => {
  await withTempDirectory(async (directory) => {
    const store = LiveRawStore.open({ directory, sessionId: 'exa_test', epoch: 'oep_1' });
    const frames = [
      {
        stream: 'stdout' as const,
        payload: '{"type":"assistant","uuid":"a"}\n',
        observedAt: '2026-07-18T01:00:00.000Z'
      },
      { stream: 'stderr' as const, payload: 'warning: 保真\n', observedAt: '2026-07-18T01:00:00.001Z' },
      {
        stream: 'app-server' as const,
        payload: '{"method":"item/completed","params":{}}',
        observedAt: '2026-07-18T01:00:00.002Z'
      }
    ];

    expect(frames.map((frame) => store.append(frame))).toEqual(
      frames.map((frame, index) => ({ seq: index + 1, ...frame }))
    );
    expect(store.page({ limit: 10, sortDirection: 'asc' })).toEqual({
      rows: frames.map((frame, index) => ({ seq: index + 1, ...frame }))
    });
    await store.closeAndDelete();
  });
});

test('live raw store pages newest rows in display order without materializing older rows', async () => {
  await withTempDirectory(async (directory) => {
    const store = LiveRawStore.open({ directory, sessionId: 'exa_test', epoch: 'oep_2' });
    for (let index = 1; index <= 5; index += 1) {
      store.append({ stream: 'stdout', payload: `frame-${index}`, observedAt: `2026-07-18T01:00:0${index}.000Z` });
    }

    expect(store.page({ limit: 2, sortDirection: 'desc' })).toEqual({
      rows: [
        { seq: 4, stream: 'stdout', payload: 'frame-4', observedAt: '2026-07-18T01:00:04.000Z' },
        { seq: 5, stream: 'stdout', payload: 'frame-5', observedAt: '2026-07-18T01:00:05.000Z' }
      ],
      nextBefore: 4
    });
    expect(store.page({ before: 4, limit: 2, sortDirection: 'desc' })).toEqual({
      rows: [
        { seq: 2, stream: 'stdout', payload: 'frame-2', observedAt: '2026-07-18T01:00:02.000Z' },
        { seq: 3, stream: 'stdout', payload: 'frame-3', observedAt: '2026-07-18T01:00:03.000Z' }
      ],
      nextBefore: 2
    });
    await store.closeAndDelete();
  });
});

test('live raw cursors are scoped to the runtime epoch', async () => {
  await withTempDirectory(async (directory) => {
    const first = LiveRawStore.open({ directory, sessionId: 'exa_test', epoch: 'oep_first' });
    first.append({ stream: 'stdout', payload: 'first', observedAt: '2026-07-18T01:00:00.000Z' });
    expect(first.cursorBefore(1)).toBe('live:oep_first:1');
    expect(first.parseCursor('live:oep_first:1')).toBe(1);
    expect(() => first.parseCursor('live:oep_other:1')).toThrow('live observation epoch is no longer available');
    await first.closeAndDelete();
  });
});

test('closeAndDelete removes the database and WAL sidecars idempotently', async () => {
  await withTempDirectory(async (directory) => {
    const store = LiveRawStore.open({ directory, sessionId: 'exa_test', epoch: 'oep_delete' });
    store.append({ stream: 'stdout', payload: 'frame', observedAt: '2026-07-18T01:00:00.000Z' });
    await store.closeAndDelete();
    await store.closeAndDelete();
    expect(await readdir(directory)).toEqual([]);
  });
});

test('startup cleanup deletes every stale live store without opening it', async () => {
  await withTempDirectory(async (directory) => {
    await Promise.all([
      writeFile(join(directory, 'stale.sqlite'), 'not a database'),
      writeFile(join(directory, 'stale.sqlite-wal'), 'wal'),
      writeFile(join(directory, 'stale.sqlite-shm'), 'shm')
    ]);

    expect(await cleanupStaleLiveRawStores(directory)).toEqual({ deleted: 3 });
    expect(await readdir(directory)).toEqual([]);
  });
});
