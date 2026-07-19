import { expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanupStaleLiveRawStores, LiveRawStore } from '#/services/mesh-agent/live-raw-store.ts';

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
    const store = LiveRawStore.open({ directory, sessionId: 'mesh_test', epoch: 'oep_1' });
    const frames = [
      {
        stream: 'stdout' as const,
        payload: '{"type":"assistant","uuid":"a"}\n',
        observedAt: '2026-07-18T01:00:00.000Z'
      },
      { stream: 'stderr' as const, payload: 'warning: 保真\n', observedAt: '2026-07-18T01:00:00.001Z' },
      { stream: 'stdout' as const, payload: '{"type":"turn.completed"}', observedAt: '2026-07-18T01:00:00.002Z' }
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
    const store = LiveRawStore.open({ directory, sessionId: 'mesh_test', epoch: 'oep_2' });
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

test('live raw store returns the same newest page on repeated reads', async () => {
  await withTempDirectory(async (directory) => {
    const store = LiveRawStore.open({ directory, sessionId: 'mesh_test', epoch: 'oep_repeat_newest' });
    for (let index = 1; index <= 5; index += 1) {
      store.append({ stream: 'stdout', payload: `frame-${index}`, observedAt: `2026-07-18T01:00:0${index}.000Z` });
    }

    const expected = {
      rows: [
        { seq: 4, stream: 'stdout' as const, payload: 'frame-4', observedAt: '2026-07-18T01:00:04.000Z' },
        { seq: 5, stream: 'stdout' as const, payload: 'frame-5', observedAt: '2026-07-18T01:00:05.000Z' }
      ],
      nextBefore: 4
    };

    expect(store.page({ limit: 2, sortDirection: 'desc' })).toEqual(expected);
    expect(store.page({ limit: 2, sortDirection: 'desc' })).toEqual(expected);
    await store.closeAndDelete();
  });
});

test('live raw store returns the same cursor page on repeated reads', async () => {
  await withTempDirectory(async (directory) => {
    const store = LiveRawStore.open({ directory, sessionId: 'mesh_test', epoch: 'oep_repeat_before' });
    for (let index = 1; index <= 5; index += 1) {
      store.append({ stream: 'stdout', payload: `frame-${index}`, observedAt: `2026-07-18T01:00:0${index}.000Z` });
    }

    const expected = {
      rows: [
        { seq: 3, stream: 'stdout' as const, payload: 'frame-3', observedAt: '2026-07-18T01:00:03.000Z' },
        { seq: 4, stream: 'stdout' as const, payload: 'frame-4', observedAt: '2026-07-18T01:00:04.000Z' }
      ],
      nextBefore: 3
    };

    expect(store.page({ before: 5, limit: 2, sortDirection: 'desc' })).toEqual(expected);
    expect(store.page({ before: 5, limit: 2, sortDirection: 'desc' })).toEqual(expected);
    await store.closeAndDelete();
  });
});

test('live raw store bounds pages by encoded payload bytes without dropping an oversized frame', async () => {
  await withTempDirectory(async (directory) => {
    const store = LiveRawStore.open({ directory, sessionId: 'mesh_test', epoch: 'oep_bytes' });
    store.append({ stream: 'stdout', payload: 'é', observedAt: '2026-07-18T01:00:01.000Z' });
    store.append({ stream: 'stdout', payload: 'two', observedAt: '2026-07-18T01:00:02.000Z' });
    store.append({ stream: 'stdout', payload: 'oversized', observedAt: '2026-07-18T01:00:03.000Z' });

    expect(store.page({ limit: 10, maxBytes: 4, sortDirection: 'desc' })).toEqual({
      rows: [{ seq: 3, stream: 'stdout', payload: 'oversized', observedAt: '2026-07-18T01:00:03.000Z' }],
      nextBefore: 3
    });
    expect(store.page({ before: 3, limit: 10, maxBytes: 4, sortDirection: 'desc' })).toEqual({
      rows: [{ seq: 2, stream: 'stdout', payload: 'two', observedAt: '2026-07-18T01:00:02.000Z' }],
      nextBefore: 2
    });
    await store.closeAndDelete();
  });
});

test('live raw store reads exact committed rows after a sequence cursor', async () => {
  await withTempDirectory(async (directory) => {
    const store = LiveRawStore.open({ directory, sessionId: 'mesh_test', epoch: 'oep_after' });
    for (let index = 1; index <= 4; index += 1) {
      store.append({ stream: 'stdout', payload: `frame-${index}`, observedAt: `2026-07-18T01:00:0${index}.000Z` });
    }

    expect(store.page({ after: 2, limit: 10, sortDirection: 'asc' })).toEqual({
      rows: [
        { seq: 3, stream: 'stdout', payload: 'frame-3', observedAt: '2026-07-18T01:00:03.000Z' },
        { seq: 4, stream: 'stdout', payload: 'frame-4', observedAt: '2026-07-18T01:00:04.000Z' }
      ]
    });
    await store.closeAndDelete();
  });
});

test('live raw cursors include the runtime epoch', async () => {
  await withTempDirectory(async (directory) => {
    const first = LiveRawStore.open({ directory, sessionId: 'mesh_test', epoch: 'oep_first' });
    first.append({ stream: 'stdout', payload: 'first', observedAt: '2026-07-18T01:00:00.000Z' });
    expect(first.cursorBefore(1)).toBe('live:oep_first:1');
    await first.closeAndDelete();
  });
});

test('closeAndDelete removes the database and WAL sidecars idempotently', async () => {
  await withTempDirectory(async (directory) => {
    const store = LiveRawStore.open({ directory, sessionId: 'mesh_test', epoch: 'oep_delete' });
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
