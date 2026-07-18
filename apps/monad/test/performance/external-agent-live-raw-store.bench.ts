import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LiveRawStore } from '#/services/external-agent/live-raw-store.ts';

const frameCount = 10_000;
const payload = `${JSON.stringify({ type: 'assistant', uuid: 'frame', message: { content: 'x'.repeat(192) } })}\n`;
const directory = await mkdtemp(join(tmpdir(), 'monad-live-raw-bench-'));

try {
  const store = LiveRawStore.open({ directory, sessionId: 'exa_benchmark', epoch: 'oep_benchmark' });
  const sqliteStarted = performance.now();
  for (let index = 0; index < frameCount; index += 1) {
    store.append({ stream: 'stdout', payload, observedAt: '2026-07-18T00:00:00.000Z' });
  }
  const sqliteMs = performance.now() - sqliteStarted;
  const pageStarted = performance.now();
  const page = store.page({ limit: 200, sortDirection: 'desc' });
  const pageMs = performance.now() - pageStarted;

  process.stdout.write(
    `${JSON.stringify({
      frameCount,
      payloadBytes: Buffer.byteLength(payload),
      sqliteFullSyncAppendMs: Number(sqliteMs.toFixed(2)),
      sqliteLatest200Ms: Number(pageMs.toFixed(2)),
      rowsRead: page.rows.length
    })}\n`
  );
  await store.closeAndDelete();
} finally {
  await rm(directory, { recursive: true, force: true });
}
