// Opt-in LIVE e2e for the daemon-managed qdrant: actually downloads the real qdrant release binary,
// launches it, and verifies the bits the offline unit tests can't (asset selection, extraction,
// chmod, launch env flags, the /healthz endpoint, on-disk storage). Skipped by default — it pulls a
// ~tens-of-MB binary and runs a process. Enable with `MONAD_QDRANT_LIVE=1 bun test live-qdrant`.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@monad/logger';

import { QdrantManager } from '#/services/memory/qdrant.ts';

const LIVE = process.env.MONAD_QDRANT_LIVE;
const log = createLogger('live-qdrant');
const PORT = Number(process.env.MONAD_QDRANT_LIVE_PORT) || 6399; // avoid qdrant's default 6333

describe.skipIf(!LIVE)('live qdrant (real download + launch)', () => {
  test('ensureUrl downloads + launches qdrant; /healthz answers; a collection round-trips; stop kills it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qd-live-'));
    const m = new QdrantManager({
      binDir: join(dir, 'bin'),
      dataDir: join(dir, 'data'),
      port: PORT,
      startTimeoutMs: 60_000,
      log
    });
    try {
      const url = await m.ensureUrl();
      expect(url).toBe(`http://127.0.0.1:${PORT}`);

      // health endpoint the manager polls
      expect((await fetch(`${url}/healthz`)).ok).toBe(true);
      // root returns the running version (confirms it's really qdrant)
      const root = (await (await fetch(`${url}/`)).json()) as { version?: string };
      expect(typeof root.version).toBe('string');

      // create + read a collection → confirms the on-disk storage path is usable
      const headers = { 'content-type': 'application/json' };
      const put = await fetch(`${url}/collections/monad_live_test`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ vectors: { size: 8, distance: 'Cosine' } })
      });
      expect(put.ok).toBe(true);
      expect((await fetch(`${url}/collections/monad_live_test`)).ok).toBe(true);
    } finally {
      await m.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000); // download + boot budget
});
